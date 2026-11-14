import { randomUUID } from 'node:crypto';
import { podeTransitar, StatusExecucao } from './status-execucao';

export class TransicaoInvalidaError extends Error {
  constructor(de: StatusExecucao, para: StatusExecucao) {
    super(`Transição inválida: ${de} → ${para}`);
    this.name = 'TransicaoInvalidaError';
  }
}

export interface Veiculo {
  placa: string;
  marca: string;
  modelo: string;
}

export interface ItemExecucao {
  tipo: string;
  descricao: string;
  quantidade: number;
}

export interface EventoLinhaDoTempo {
  id: string;
  etapa: StatusExecucao;
  observacao?: string;
  /** Epoch em ms. */
  em: number;
}

export interface ExecucaoProps {
  id: string;
  osId: string;
  osNumero?: number | string;
  veiculo?: Veiculo;
  itens?: ItemExecucao[];
  status: StatusExecucao;
  enfileiradaEm: number;
  atualizadaEm: number;
  finalizadaEm?: number;
  motivo?: string;
  versao: number;
  linhaDoTempo?: EventoLinhaDoTempo[];
}

export interface AgendarExecucaoDados {
  osId: string;
  osNumero?: number | string;
  veiculo?: Veiculo;
  itens?: ItemExecucao[];
}

/**
 * Agregado Execucao. Concentra a maquina de estados e a linha do tempo;
 * nao depende de framework nem de banco.
 */
export class Execucao {
  readonly id: string;
  readonly osId: string;
  readonly osNumero?: number | string;
  readonly veiculo?: Veiculo;
  readonly itens: ItemExecucao[];
  /** Datas em epoch ms (CONTRATO-MENSAGENS.md, secao Datas). */
  readonly enfileiradaEm: number;
  /** Versao lida do banco; base da concorrencia otimista. */
  readonly versao: number;
  status: StatusExecucao;
  atualizadaEm: number;
  finalizadaEm?: number;
  /** Motivo da falha ou do cancelamento. */
  motivo?: string;
  readonly linhaDoTempo: EventoLinhaDoTempo[];
  /** Eventos da linha do tempo ainda nao persistidos. */
  readonly eventosNovos: EventoLinhaDoTempo[] = [];

  constructor(props: ExecucaoProps) {
    if (!props.osId) throw new Error('osId é obrigatório');
    this.id = props.id;
    this.osId = props.osId;
    this.osNumero = props.osNumero;
    this.veiculo = props.veiculo;
    this.itens = props.itens ?? [];
    this.status = props.status;
    this.enfileiradaEm = props.enfileiradaEm;
    this.atualizadaEm = props.atualizadaEm;
    this.finalizadaEm = props.finalizadaEm;
    this.motivo = props.motivo;
    this.versao = props.versao;
    this.linhaDoTempo = props.linhaDoTempo ?? [];
  }

  static agendar(dados: AgendarExecucaoDados, agora = Date.now()): Execucao {
    const execucao = new Execucao({
      ...dados,
      id: randomUUID(),
      status: StatusExecucao.NA_FILA,
      enfileiradaEm: agora,
      atualizadaEm: agora,
      versao: 0,
    });
    execucao.registrar(StatusExecucao.NA_FILA, undefined, agora);
    return execucao;
  }

  get emAndamento(): boolean {
    return (
      this.status === StatusExecucao.EM_DIAGNOSTICO || this.status === StatusExecucao.EM_REPARO
    );
  }

  get encerrada(): boolean {
    return [StatusExecucao.FINALIZADA, StatusExecucao.FALHOU, StatusExecucao.CANCELADA].includes(
      this.status,
    );
  }

  /** Duracao em segundos de NA_FILA a FINALIZADA; nula se nao finalizou. */
  get duracaoSegundos(): number | null {
    if (!this.finalizadaEm) return null;
    return (this.finalizadaEm - this.enfileiradaEm) / 1000;
  }

  iniciarDiagnostico(observacao?: string, agora = Date.now()): void {
    this.transitar(StatusExecucao.EM_DIAGNOSTICO, observacao, agora);
  }

  iniciarReparo(observacao?: string, agora = Date.now()): void {
    this.transitar(StatusExecucao.EM_REPARO, observacao, agora);
  }

  finalizar(agora = Date.now()): void {
    this.transitar(StatusExecucao.FINALIZADA, undefined, agora);
    this.finalizadaEm = agora;
  }

  falhar(motivo: string, agora = Date.now()): void {
    if (!motivo?.trim()) throw new Error('motivo é obrigatório');
    this.transitar(StatusExecucao.FALHOU, motivo, agora);
    this.motivo = motivo;
  }

  cancelar(motivo?: string, agora = Date.now()): void {
    this.transitar(StatusExecucao.CANCELADA, motivo, agora);
    this.motivo = motivo;
  }

  private transitar(para: StatusExecucao, observacao: string | undefined, agora: number): void {
    if (!podeTransitar(this.status, para)) throw new TransicaoInvalidaError(this.status, para);
    this.status = para;
    this.atualizadaEm = agora;
    this.registrar(para, observacao, agora);
  }

  private registrar(etapa: StatusExecucao, observacao: string | undefined, em: number): void {
    const evento = { id: randomUUID(), etapa, observacao, em };
    this.linhaDoTempo.push(evento);
    this.eventosNovos.push(evento);
  }
}

/** Ordem da fila: em andamento primeiro, depois por ordem de chegada. */
export function ordenarFila(execucoes: Execucao[]): Execucao[] {
  return [...execucoes].sort(
    (a, b) => Number(b.emAndamento) - Number(a.emAndamento) || a.enfileiradaEm - b.enfileiradaEm,
  );
}
