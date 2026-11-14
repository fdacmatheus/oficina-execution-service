import { randomUUID } from 'node:crypto';
import { traceparentAtual } from '../observabilidade/telemetria';

export const ORIGEM = 'execution-service';

/** Envelope do contrato de mensagens (CONTRATO-MENSAGENS.md). */
export interface Envelope<P = Record<string, unknown>> {
  messageId: string;
  type: string;
  correlationId: string;
  /** Epoch em ms. */
  occurredAt: number;
  source: string;
  payload: P;
  /** Contexto W3C do trace em que o evento foi criado; opcional no contrato. */
  traceparent?: string;
}

export function criarEnvelope<P>(
  type: string,
  correlationId: string,
  payload: P,
  agora = Date.now(),
): Envelope<P> {
  return {
    messageId: randomUUID(),
    type,
    correlationId,
    occurredAt: agora,
    source: ORIGEM,
    payload,
    traceparent: traceparentAtual(),
  };
}
