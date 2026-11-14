import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Envelope } from 'src/shared/mensageria/envelope';
import { contextoRequisicao } from 'src/shared/observabilidade/correlacao.middleware';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import { emSpanDaMensagem, semRastreamento } from 'src/shared/observabilidade/telemetria';
import { CancelarExecucaoDados, ExecucoesService } from '../application/execucoes.service';
import type { AgendarExecucaoDados } from '../domain/execucao.entity';
import { MensagemDuplicadaError } from '../domain/execucao.repository';

/**
 * Consumidor de `execution-comandos` por long polling. A mensagem so e apagada
 * depois de processada; em erro ela volta apos o visibility timeout e, apos 5
 * tentativas, vai para a DLQ.
 */
@Injectable()
export class ConsumidorComandos implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ConsumidorComandos.name);
  private ativo = false;
  private abortador?: AbortController;
  private laco?: Promise<void>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly execucoes: ExecucoesService,
    private readonly config: ConfigService,
    private readonly metricas: MetricasService,
  ) {}

  private get filaUrl(): string {
    return this.config.getOrThrow<string>('SQS_EXECUTION_COMANDOS_URL');
  }

  onApplicationBootstrap(): void {
    if (this.config.get('SQS_CONSUMER_ENABLED', 'true') !== 'true') return;
    this.ativo = true;
    this.laco = semRastreamento(() => this.consumir());
    this.logger.log(`Consumindo ${this.filaUrl}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.ativo = false;
    this.abortador?.abort();
    await this.laco;
  }

  private async consumir(): Promise<void> {
    while (this.ativo) {
      try {
        await this.consumirLote();
      } catch (erro) {
        if (!this.ativo) break;
        this.logger.error(`Falha ao receber de execution-comandos: ${(erro as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** Recebe ate 10 mensagens (long polling de 20 s) e processa cada uma. */
  async consumirLote(): Promise<void> {
    this.abortador = new AbortController();
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.filaUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.abortador.signal },
    );
    for (const mensagem of Messages) await this.processar(mensagem);
  }

  async processar(mensagem: Message): Promise<void> {
    const correlationId = mensagem.MessageAttributes?.correlationId?.StringValue ?? 'desconhecido';
    await contextoRequisicao.run({ correlationId }, async () => {
      let tipo = mensagem.MessageAttributes?.type?.StringValue ?? 'desconhecido';
      try {
        const envelope = JSON.parse(mensagem.Body ?? '') as Envelope;
        tipo = envelope.type;
        await emSpanDaMensagem(
          `processar ${tipo}`,
          'consumidor',
          envelope.traceparent,
          { 'messaging.source.name': 'execution-comandos', 'oficina.os_id': correlationId },
          () => this.despachar(envelope),
        );
        this.metricas.mensagensConsumidas.inc({ tipo, resultado: 'sucesso' });
        this.logger.log(`${tipo} processada (${envelope.messageId})`);
      } catch (erro) {
        if (!(erro instanceof MensagemDuplicadaError)) {
          this.metricas.mensagensConsumidas.inc({ tipo, resultado: 'erro' });
          this.logger.error(`Falha ao processar ${tipo}: ${(erro as Error).message}`);
          return; // nao apaga: volta para a fila e, apos 5 tentativas, DLQ
        }
        this.metricas.mensagensConsumidas.inc({ tipo, resultado: 'duplicada' });
        this.logger.warn(erro.message);
      }
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.filaUrl, ReceiptHandle: mensagem.ReceiptHandle }),
      );
    });
  }

  private async despachar(envelope: Envelope): Promise<void> {
    if (!envelope.messageId) throw new Error('Envelope sem messageId');
    switch (envelope.type) {
      case 'AgendarExecucao':
        await this.execucoes.agendar(
          envelope.payload as unknown as AgendarExecucaoDados,
          envelope.messageId,
        );
        return;
      case 'CancelarExecucao':
        await this.execucoes.cancelar(
          envelope.payload as unknown as CancelarExecucaoDados,
          envelope.messageId,
        );
        return;
      default:
        throw new Error(`Tipo de mensagem desconhecido: ${envelope.type}`);
    }
  }
}
