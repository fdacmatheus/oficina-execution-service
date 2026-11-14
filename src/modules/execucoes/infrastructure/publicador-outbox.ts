import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Envelope } from 'src/shared/mensageria/envelope';
import { contextoRequisicao } from 'src/shared/observabilidade/correlacao.middleware';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import { emSpanDaMensagem, semRastreamento } from 'src/shared/observabilidade/telemetria';
import { chaves, DYNAMODB_TABLE } from './execucao.dynamo.repository';

interface ItemOutbox {
  pk: string;
  sk: string;
  tipo: string;
  fila: string;
  corpo: string;
  correlationId: string;
}

/**
 * Publicador do outbox transacional. A cada intervalo le `pk = OUTBOX`, envia
 * ao SQS e so entao apaga o item. Se o processo cair entre o envio e o delete,
 * a mensagem sai de novo: o consumidor e idempotente por messageId.
 */
@Injectable()
export class PublicadorOutbox implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PublicadorOutbox.name);
  private timer?: NodeJS.Timeout;
  private publicando = false;

  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly sqs: SQSClient,
    @Inject(DYNAMODB_TABLE) private readonly tabela: string,
    private readonly config: ConfigService,
    private readonly metricas: MetricasService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('OUTBOX_PUBLISHER_ENABLED', 'true') !== 'true') return;
    const intervalo = Number(this.config.get('OUTBOX_INTERVAL_MS', 1000));
    this.timer = setInterval(() => void semRastreamento(() => this.publicarPendentes()), intervalo);
    this.logger.log(`Publicador do outbox ativo (${intervalo} ms)`);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** Publica um lote; ignora a chamada se o lote anterior ainda esta em curso. */
  async publicarPendentes(): Promise<number> {
    if (this.publicando) return 0;
    this.publicando = true;
    let enviados = 0;
    try {
      const { Items = [] } = await this.db.send(
        new QueryCommand({
          TableName: this.tabela,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': chaves.outbox },
          Limit: 25,
        }),
      );
      for (const item of Items as ItemOutbox[]) {
        // O span de publicacao e filho do trace em que o evento foi criado
        // (comando consumido ou requisicao HTTP), guardado no proprio envelope.
        const { traceparent } = JSON.parse(item.corpo) as Envelope;
        await contextoRequisicao.run({ correlationId: item.correlationId }, () =>
          emSpanDaMensagem(
            `publicar ${item.tipo}`,
            'produtor',
            traceparent,
            { 'messaging.destination.name': item.fila, 'oficina.os_id': item.correlationId },
            () => this.publicar(item),
          ),
        );
        enviados++;
      }
    } catch (erro) {
      this.logger.error(`Falha ao publicar o outbox: ${(erro as Error).message}`);
    } finally {
      this.publicando = false;
    }
    return enviados;
  }

  private async publicar(item: ItemOutbox): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.urlDaFila(item.fila),
        MessageBody: item.corpo,
        MessageAttributes: {
          type: { DataType: 'String', StringValue: item.tipo },
          correlationId: { DataType: 'String', StringValue: item.correlationId },
        },
      }),
    );
    await this.db.send(
      new DeleteCommand({ TableName: this.tabela, Key: { pk: item.pk, sk: item.sk } }),
    );
    this.metricas.mensagensPublicadas.inc({ tipo: item.tipo });
    this.logger.log(`${item.tipo} publicada em ${item.fila}`);
  }

  /** `os-eventos` → SQS_OS_EVENTOS_URL. */
  private urlDaFila(fila: string): string {
    return this.config.getOrThrow<string>(`SQS_${fila.toUpperCase().replace(/-/g, '_')}_URL`);
  }
}
