import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import { Execucao } from '../domain/execucao.entity';
import {
  Alteracao,
  ConflitoConcorrenciaError,
  ExecucaoRepository,
  MensagemDuplicadaError,
} from '../domain/execucao.repository';
import { STATUS_ATIVOS, StatusExecucao } from '../domain/status-execucao';
import { ExecucoesService } from './execucoes.service';

/** Repositorio em memoria com inbox e outbox, como o do DynamoDB. */
class RepositorioFake implements ExecucaoRepository {
  execucoes = new Map<string, Execucao>();
  inbox = new Set<string>();
  outbox: Alteracao['mensagens'] = [];
  falharCom?: Error;

  async buscar(osId: string) {
    return this.execucoes.get(osId) ?? null;
  }
  async listarPorStatus(status: readonly StatusExecucao[]) {
    return [...this.execucoes.values()].filter((e) => status.includes(e.status));
  }
  async contarPorStatus(status: readonly StatusExecucao[]) {
    const lista = await this.listarPorStatus(status);
    return Object.fromEntries(status.map((s) => [s, lista.filter((e) => e.status === s).length]));
  }
  async contarAFrente(execucao: Execucao) {
    return [...this.execucoes.values()].filter(
      (e) => e.status === StatusExecucao.NA_FILA && e.enfileiradaEm < execucao.enfileiradaEm,
    ).length;
  }
  async persistir({ execucao, mensagens, mensagemRecebidaId }: Alteracao) {
    if (this.falharCom) throw this.falharCom;
    if (mensagemRecebidaId && this.inbox.has(mensagemRecebidaId)) {
      throw new MensagemDuplicadaError(mensagemRecebidaId);
    }
    if (mensagemRecebidaId) this.inbox.add(mensagemRecebidaId);
    if (execucao) this.execucoes.set(execucao.osId, execucao);
    this.outbox.push(...mensagens);
  }
}

const agendar = (osId: string) => ({ osId, osNumero: 7, itens: [] });

describe('ExecucoesService', () => {
  let repo: RepositorioFake;
  let metricas: MetricasService;
  let service: ExecucoesService;

  beforeEach(() => {
    repo = new RepositorioFake();
    metricas = new MetricasService();
    service = new ExecucoesService(repo, metricas);
  });

  const ultimo = () => repo.outbox[repo.outbox.length - 1];

  it('registra a fonte do tamanho da fila nas metricas', async () => {
    service.onModuleInit();
    await service.agendar(agendar('os-1'), 'm1');
    await expect(metricas.fonteTamanhoFila!()).resolves.toEqual({
      NA_FILA: 1,
      EM_DIAGNOSTICO: 0,
      EM_REPARO: 0,
    });
  });

  describe('agendar', () => {
    it('cria NA_FILA e publica ExecucaoAgendada com a posicao', async () => {
      await service.agendar(agendar('os-1'), 'm1');
      await new Promise((r) => setTimeout(r, 2));
      const e2 = await service.agendar(agendar('os-2'), 'm2');

      expect(e2.status).toBe(StatusExecucao.NA_FILA);
      expect(ultimo().fila).toBe('os-eventos');
      expect(ultimo().envelope).toMatchObject({
        type: 'ExecucaoAgendada',
        correlationId: 'os-2',
        source: 'execution-service',
        payload: { osId: 'os-2', execucaoId: e2.id, posicaoNaFila: 2 },
      });
    });

    it('e idempotente por osId: republica sem recriar', async () => {
      const e1 = await service.agendar(agendar('os-1'), 'm1');
      const e2 = await service.agendar(agendar('os-1'), 'm2');
      expect(e2).toBe(e1);
      expect(repo.outbox).toHaveLength(2);
      expect(ultimo().envelope.payload).toMatchObject({ execucaoId: e1.id, posicaoNaFila: 1 });
    });

    it('republica com posicao 0 quando ja saiu da fila', async () => {
      await service.agendar(agendar('os-1'), 'm1');
      await service.iniciarDiagnostico('os-1');
      await service.agendar(agendar('os-1'), 'm2');
      expect(ultimo().envelope.payload).toMatchObject({ posicaoNaFila: 0 });
    });

    it('propaga a duplicata do inbox', async () => {
      await service.agendar(agendar('os-1'), 'm1');
      await expect(service.agendar(agendar('os-1'), 'm1')).rejects.toThrow(MensagemDuplicadaError);
    });
  });

  describe('cancelar', () => {
    it('cancela e publica ExecucaoCancelada', async () => {
      await service.agendar(agendar('os-1'), 'm1');
      await service.cancelar({ osId: 'os-1', motivo: 'desistiu' }, 'm2');
      expect((await repo.buscar('os-1'))!.status).toBe(StatusExecucao.CANCELADA);
      expect(ultimo().envelope).toMatchObject({ type: 'ExecucaoCancelada' });
    });

    it('ja cancelada: republica sem alterar', async () => {
      await service.agendar(agendar('os-1'), 'm1');
      await service.cancelar({ osId: 'os-1' }, 'm2');
      await service.cancelar({ osId: 'os-1' }, 'm3');
      expect(repo.outbox.map((m) => m.envelope.type)).toEqual([
        'ExecucaoAgendada',
        'ExecucaoCancelada',
        'ExecucaoCancelada',
      ]);
    });

    it('ignora inexistente e encerrada', async () => {
      await service.cancelar({ osId: 'nada' }, 'm0');
      await service.agendar(agendar('os-1'), 'm1');
      await service.iniciarDiagnostico('os-1');
      await service.falhar('os-1', 'quebrou');
      const antes = repo.outbox.length;
      await service.cancelar({ osId: 'os-1' }, 'm2');
      expect(repo.outbox).toHaveLength(antes);
      expect((await repo.buscar('os-1'))!.status).toBe(StatusExecucao.FALHOU);
    });
  });

  describe('operacoes da oficina', () => {
    beforeEach(() => service.agendar(agendar('os-1'), 'm1'));

    it('lista a fila ativa ordenada', async () => {
      await service.agendar(agendar('os-2'), 'm2');
      await service.iniciarDiagnostico('os-2');
      const fila = await service.listarFila();
      expect(fila.map((e) => e.osId)).toEqual(['os-2', 'os-1']);
      expect(STATUS_ATIVOS).toContain(fila[0].status);
    });

    it('diagnostico → reparo → finalizar publica os eventos e observa a duracao', async () => {
      const observar = jest.spyOn(metricas.duracaoExecucao, 'observe');
      await service.iniciarDiagnostico('os-1', 'ruído');
      expect(ultimo().envelope).toMatchObject({
        type: 'ExecucaoAtualizada',
        payload: { etapa: 'EM_DIAGNOSTICO', observacao: 'ruído' },
      });
      await service.iniciarReparo('os-1');
      expect(ultimo().envelope.payload).toMatchObject({ etapa: 'EM_REPARO' });
      const e = await service.finalizar('os-1');
      expect(e.status).toBe(StatusExecucao.FINALIZADA);
      expect(ultimo().envelope.type).toBe('ExecucaoFinalizada');
      expect(observar).toHaveBeenCalledTimes(1);
    });

    it('falhar publica ExecucaoFalhou e conta a falha', async () => {
      const falhas = jest.spyOn(metricas.falhas, 'inc');
      await service.iniciarDiagnostico('os-1');
      await service.falhar('os-1', 'sem peça');
      expect(ultimo().envelope).toMatchObject({
        type: 'ExecucaoFalhou',
        payload: { osId: 'os-1', motivo: 'sem peça' },
      });
      expect(falhas).toHaveBeenCalled();
    });

    it('transicao invalida → 400', async () => {
      await expect(service.finalizar('os-1')).rejects.toThrow(BadRequestException);
    });

    it('inexistente → 404', async () => {
      await expect(service.obter('nada')).rejects.toThrow(NotFoundException);
    });

    it('conflito de versao → 409', async () => {
      repo.falharCom = new ConflitoConcorrenciaError('os-1');
      await expect(service.iniciarDiagnostico('os-1')).rejects.toThrow(ConflictException);
    });

    it('outros erros sobem intactos', async () => {
      repo.falharCom = new Error('dynamo fora');
      await expect(service.iniciarDiagnostico('os-1')).rejects.toThrow('dynamo fora');
    });
  });
});
