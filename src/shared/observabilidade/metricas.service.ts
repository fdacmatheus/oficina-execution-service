import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Fonte do tamanho da fila; o caso de uso de execucoes a registra no init. */
export type FonteTamanhoFila = () => Promise<Record<string, number>>;

/** Registro central das metricas expostas em `/api/metrics`. */
@Injectable()
export class MetricasService implements OnModuleInit {
  readonly registry = new Registry();
  fonteTamanhoFila?: FonteTamanhoFila;

  /** Requisicoes HTTP por metodo, rota e codigo de status. */
  readonly requisicoes = new Counter({
    name: 'http_requests_total',
    help: 'Total de requisicoes HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });

  /** Latencia das requisicoes, base dos percentis p50 e p95. */
  readonly duracaoRequisicao = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duracao das requisicoes HTTP em segundos',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /**
   * Tamanho da fila por status. E lido do DynamoDB no momento do scrape, e nao
   * mantido em memoria, porque com varias replicas cada pod veria so a sua parte.
   */
  readonly tamanhoFila = new Gauge({
    name: 'oficina_execucao_fila_tamanho',
    help: 'Execucoes ativas por status (NA_FILA, EM_DIAGNOSTICO, EM_REPARO)',
    labelNames: ['status'] as const,
    registers: [this.registry],
    collect: async () => {
      if (!this.fonteTamanhoFila) return;
      const contagem = await this.fonteTamanhoFila();
      for (const [status, total] of Object.entries(contagem)) {
        this.tamanhoFila.set({ status }, total);
      }
    },
  });

  /** Tempo total da execucao, de NA_FILA a FINALIZADA. */
  readonly duracaoExecucao = new Histogram({
    name: 'oficina_execucao_duracao_segundos',
    help: 'Duracao da execucao, do enfileiramento a finalizacao',
    buckets: [300, 900, 1800, 3600, 7200, 14400, 28800, 86400, 172800],
    registers: [this.registry],
  });

  /** Transicoes por etapa de destino. */
  readonly transicoes = new Counter({
    name: 'oficina_execucao_transicoes_total',
    help: 'Transicoes de etapa da execucao',
    labelNames: ['etapa'] as const,
    registers: [this.registry],
  });

  /** Execucoes que falharam, gatilho da compensacao da saga. */
  readonly falhas = new Counter({
    name: 'oficina_execucao_falhas_total',
    help: 'Execucoes encerradas com falha',
    registers: [this.registry],
  });

  /** Mensagens consumidas de execution-comandos por tipo e resultado. */
  readonly mensagensConsumidas = new Counter({
    name: 'oficina_mensagens_consumidas_total',
    help: 'Mensagens SQS consumidas',
    labelNames: ['tipo', 'resultado'] as const,
    registers: [this.registry],
  });

  /** Mensagens publicadas pelo outbox por tipo. */
  readonly mensagensPublicadas = new Counter({
    name: 'oficina_mensagens_publicadas_total',
    help: 'Mensagens SQS publicadas a partir do outbox',
    labelNames: ['tipo'] as const,
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry, prefix: 'oficina_' });
  }

  async expor(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
