import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { criarEnvelope } from 'src/shared/mensageria/envelope';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import {
  AgendarExecucaoDados,
  Execucao,
  ordenarFila,
  TransicaoInvalidaError,
} from '../domain/execucao.entity';
import {
  ConflitoConcorrenciaError,
  EXECUCAO_REPOSITORY,
  type ExecucaoRepository,
  type MensagemSaida,
} from '../domain/execucao.repository';
import { STATUS_ATIVOS, StatusExecucao } from '../domain/status-execucao';

export const FILA_OS_EVENTOS = 'os-eventos';

export interface CancelarExecucaoDados {
  osId: string;
  motivo?: string;
}

/** Casos de uso da execucao: comandos da saga e operacoes da oficina. */
@Injectable()
export class ExecucoesService implements OnModuleInit {
  private readonly logger = new Logger(ExecucoesService.name);

  constructor(
    @Inject(EXECUCAO_REPOSITORY) private readonly repo: ExecucaoRepository,
    private readonly metricas: MetricasService,
  ) {}

  onModuleInit(): void {
    this.metricas.fonteTamanhoFila = () => this.repo.contarPorStatus(STATUS_ATIVOS);
  }

  // ---------- Comandos (execution-comandos) ----------

  /** Idempotente por osId: se ja existe, so republica ExecucaoAgendada. */
  async agendar(dados: AgendarExecucaoDados, mensagemId: string): Promise<Execucao> {
    const existente = await this.repo.buscar(dados.osId);
    const execucao = existente ?? Execucao.agendar(dados);
    const posicaoNaFila =
      execucao.status === StatusExecucao.NA_FILA
        ? (await this.repo.contarAFrente(execucao)) + 1
        : 0;

    await this.repo.persistir({
      execucao: existente ? undefined : execucao,
      mensagens: [this.evento('ExecucaoAgendada', execucao, { posicaoNaFila })],
      mensagemRecebidaId: mensagemId,
    });

    if (existente) {
      this.logger.warn(`Execução da OS ${dados.osId} já existia; ExecucaoAgendada republicada`);
    } else {
      this.metricas.transicoes.inc({ etapa: StatusExecucao.NA_FILA });
    }
    return execucao;
  }

  /** Idempotente: cancelada de novo republica o evento; encerrada de outro modo, ignora. */
  async cancelar(dados: CancelarExecucaoDados, mensagemId: string): Promise<void> {
    const execucao = await this.repo.buscar(dados.osId);
    if (!execucao) {
      this.logger.warn(`CancelarExecucao para OS ${dados.osId} sem execução; ignorado`);
      return;
    }
    const jaCancelada = execucao.status === StatusExecucao.CANCELADA;
    if (execucao.encerrada && !jaCancelada) {
      this.logger.warn(`Execução da OS ${dados.osId} já está ${execucao.status}; ignorado`);
      return;
    }
    if (!jaCancelada) execucao.cancelar(dados.motivo);

    await this.repo.persistir({
      execucao: jaCancelada ? undefined : execucao,
      mensagens: [this.evento('ExecucaoCancelada', execucao, {})],
      mensagemRecebidaId: mensagemId,
    });
    if (!jaCancelada) this.metricas.transicoes.inc({ etapa: StatusExecucao.CANCELADA });
  }

  // ---------- Operacoes da oficina (HTTP) ----------

  async listarFila(): Promise<Execucao[]> {
    return ordenarFila(await this.repo.listarPorStatus(STATUS_ATIVOS));
  }

  async obter(osId: string): Promise<Execucao> {
    const execucao = await this.repo.buscar(osId);
    if (!execucao) throw new NotFoundException(`Execução da OS ${osId} não encontrada`);
    return execucao;
  }

  iniciarDiagnostico(osId: string, observacao?: string): Promise<Execucao> {
    return this.transitar(osId, (e) => {
      e.iniciarDiagnostico(observacao);
      return this.evento('ExecucaoAtualizada', e, { etapa: e.status, observacao });
    });
  }

  iniciarReparo(osId: string, observacao?: string): Promise<Execucao> {
    return this.transitar(osId, (e) => {
      e.iniciarReparo(observacao);
      return this.evento('ExecucaoAtualizada', e, { etapa: e.status, observacao });
    });
  }

  finalizar(osId: string): Promise<Execucao> {
    return this.transitar(osId, (e) => {
      e.finalizar();
      return this.evento('ExecucaoFinalizada', e, {});
    });
  }

  falhar(osId: string, motivo: string): Promise<Execucao> {
    return this.transitar(osId, (e) => {
      e.falhar(motivo);
      return this.evento('ExecucaoFalhou', e, { motivo });
    });
  }

  private async transitar(
    osId: string,
    acao: (execucao: Execucao) => MensagemSaida,
  ): Promise<Execucao> {
    const execucao = await this.obter(osId);
    let mensagem: MensagemSaida;
    try {
      mensagem = acao(execucao);
      await this.repo.persistir({ execucao, mensagens: [mensagem] });
    } catch (erro) {
      if (erro instanceof TransicaoInvalidaError) throw new BadRequestException(erro.message);
      if (erro instanceof ConflitoConcorrenciaError) throw new ConflictException(erro.message);
      throw erro;
    }

    this.metricas.transicoes.inc({ etapa: execucao.status });
    if (execucao.status === StatusExecucao.FALHOU) this.metricas.falhas.inc();
    if (execucao.duracaoSegundos !== null) {
      this.metricas.duracaoExecucao.observe(execucao.duracaoSegundos);
    }
    this.logger.log(`Execução da OS ${osId} → ${execucao.status}`);
    return execucao;
  }

  private evento(type: string, execucao: Execucao, extra: object): MensagemSaida {
    return {
      fila: FILA_OS_EVENTOS,
      envelope: criarEnvelope(type, execucao.osId, {
        osId: execucao.osId,
        execucaoId: execucao.id,
        ...extra,
      }),
    };
  }
}
