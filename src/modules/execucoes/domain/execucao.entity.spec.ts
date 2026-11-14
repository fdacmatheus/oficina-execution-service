import { Execucao, ordenarFila, TransicaoInvalidaError } from './execucao.entity';
import { podeTransitar, StatusExecucao } from './status-execucao';

const T0 = 1763114400000;
const minutos = (n: number) => T0 + n * 60_000;

function nova(osId = 'os-1', agora = T0) {
  return Execucao.agendar(
    { osId, osNumero: 1, veiculo: { placa: 'ABC1D23', marca: 'Fiat', modelo: 'Uno' } },
    agora,
  );
}

describe('Execucao', () => {
  it('agenda na fila com versao 0 e o primeiro evento da linha do tempo', () => {
    const e = nova();
    expect(e.status).toBe(StatusExecucao.NA_FILA);
    expect(e.versao).toBe(0);
    expect(e.itens).toEqual([]);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.eventosNovos).toHaveLength(1);
    expect(e.linhaDoTempo[0]).toMatchObject({ etapa: StatusExecucao.NA_FILA, em: T0 });
    expect(e.emAndamento).toBe(false);
    expect(e.encerrada).toBe(false);
  });

  it('exige osId', () => {
    expect(() => Execucao.agendar({ osId: '' })).toThrow('osId é obrigatório');
  });

  it('percorre o caminho feliz e mede a duracao', () => {
    const e = nova();
    e.iniciarDiagnostico('barulho', minutos(5));
    expect(e.emAndamento).toBe(true);
    e.iniciarReparo(undefined, minutos(10));
    expect(e.duracaoSegundos).toBeNull();
    e.finalizar(minutos(30));
    expect(e.status).toBe(StatusExecucao.FINALIZADA);
    expect(e.encerrada).toBe(true);
    expect(e.duracaoSegundos).toBe(1800);
    expect(e.linhaDoTempo.map((x) => x.etapa)).toEqual([
      StatusExecucao.NA_FILA,
      StatusExecucao.EM_DIAGNOSTICO,
      StatusExecucao.EM_REPARO,
      StatusExecucao.FINALIZADA,
    ]);
    expect(e.linhaDoTempo[1].observacao).toBe('barulho');
    expect(e.atualizadaEm).toBe(minutos(30));
  });

  it('falha a partir do diagnostico ou do reparo, com motivo', () => {
    const a = nova();
    a.iniciarDiagnostico();
    a.falhar('peça errada');
    expect(a.status).toBe(StatusExecucao.FALHOU);
    expect(a.motivo).toBe('peça errada');

    const b = nova();
    b.iniciarDiagnostico();
    b.iniciarReparo();
    b.falhar('quebrou');
    expect(b.status).toBe(StatusExecucao.FALHOU);
  });

  it('nao falha sem motivo nem a partir da fila', () => {
    const e = nova();
    expect(() => e.falhar('peça')).toThrow(TransicaoInvalidaError);
    e.iniciarDiagnostico();
    expect(() => e.falhar('  ')).toThrow('motivo é obrigatório');
  });

  it('cancela enquanto nao encerrada', () => {
    const e = nova();
    e.cancelar('cliente desistiu');
    expect(e.status).toBe(StatusExecucao.CANCELADA);
    expect(e.motivo).toBe('cliente desistiu');
    expect(() => e.cancelar()).toThrow(TransicaoInvalidaError);
  });

  it.each([
    ['reparo direto da fila', (e: Execucao) => e.iniciarReparo()],
    ['finalizar da fila', (e: Execucao) => e.finalizar()],
  ])('rejeita %s', (_nome, acao) => {
    expect(() => acao(nova())).toThrow('Transição inválida: NA_FILA');
  });

  it('nao sai de estados terminais', () => {
    for (const fim of [
      StatusExecucao.FINALIZADA,
      StatusExecucao.FALHOU,
      StatusExecucao.CANCELADA,
    ]) {
      for (const para of Object.values(StatusExecucao)) {
        expect(podeTransitar(fim, para)).toBe(false);
      }
    }
  });

  it('ordena a fila: em andamento primeiro, depois por chegada', () => {
    const a = nova('a', minutos(1));
    const b = nova('b', minutos(2));
    const c = nova('c', minutos(3));
    const d = nova('d', minutos(0));
    c.iniciarDiagnostico();
    b.iniciarDiagnostico();
    b.iniciarReparo();
    expect(ordenarFila([a, c, d, b]).map((e) => e.osId)).toEqual(['b', 'c', 'd', 'a']);
  });
});
