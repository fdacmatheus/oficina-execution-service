import type { Envelope } from 'src/shared/mensageria/envelope';
import type { Execucao } from './execucao.entity';
import type { StatusExecucao } from './status-execucao';

export const EXECUCAO_REPOSITORY = Symbol('EXECUCAO_REPOSITORY');

/** A mensagem recebida ja foi processada (inbox). */
export class MensagemDuplicadaError extends Error {
  constructor(messageId: string) {
    super(`Mensagem ${messageId} já processada`);
    this.name = 'MensagemDuplicadaError';
  }
}

/** Outra escrita alterou a execucao entre a leitura e a gravacao. */
export class ConflitoConcorrenciaError extends Error {
  constructor(osId: string) {
    super(`A execução da OS ${osId} foi alterada por outra operação; tente novamente`);
    this.name = 'ConflitoConcorrenciaError';
  }
}

/** Mensagem a publicar, gravada no outbox. `fila` e o nome logico da fila. */
export interface MensagemSaida {
  fila: string;
  envelope: Envelope;
}

/**
 * Tudo o que precisa ser gravado de forma atomica: o novo estado da execucao
 * (com os eventos novos da linha do tempo), as mensagens do outbox e o registro
 * da mensagem recebida (inbox).
 */
export interface Alteracao {
  execucao?: Execucao;
  mensagens: MensagemSaida[];
  mensagemRecebidaId?: string;
}

export interface ExecucaoRepository {
  buscar(osId: string): Promise<Execucao | null>;
  listarPorStatus(status: readonly StatusExecucao[]): Promise<Execucao[]>;
  contarPorStatus(status: readonly StatusExecucao[]): Promise<Record<string, number>>;
  /** Quantas execucoes NA_FILA chegaram antes desta. */
  contarAFrente(execucao: Execucao): Promise<number>;
  /** Grava a alteracao em uma unica transacao. */
  persistir(alteracao: Alteracao): Promise<void>;
}
