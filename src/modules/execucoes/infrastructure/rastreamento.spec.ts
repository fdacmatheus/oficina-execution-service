import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { mockClient } from 'aws-sdk-client-mock';
import { criarEnvelope, Envelope } from 'src/shared/mensageria/envelope';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import type { ExecucoesService } from '../application/execucoes.service';
import { ConsumidorComandos } from './consumidor-comandos';
import { PublicadorOutbox } from './publicador-outbox';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const ORIGEM = `00-${TRACE}-b7ad6b7169203331-01`;

describe('rastreamento entre servicos (traceparent no envelope)', () => {
  const exportador = new InMemorySpanExporter();
  const sqs = new SQSClient({ region: 'us-east-1' });
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
  const sqsMock = mockClient(sqs);
  const ddb = mockClient(db);
  const config = new ConfigService({
    SQS_EXECUTION_COMANDOS_URL: 'http://fila/execution-comandos',
    SQS_OS_EVENTOS_URL: 'http://fila/os-eventos',
  });

  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exportador)] }),
    );
  });

  afterAll(() => {
    trace.disable();
    propagation.disable();
    context.disable();
  });

  beforeEach(() => {
    exportador.reset();
    sqsMock.reset();
    ddb.reset();
  });

  it('o evento criado ao processar o comando carrega o trace do comando', async () => {
    sqsMock.on(DeleteMessageCommand).resolves({});
    let evento: Envelope | undefined;
    const execucoes = {
      agendar: jest.fn(async () => {
        evento = criarEnvelope('ExecucaoAgendada', 'os-1', {});
      }),
    } as unknown as ExecucoesService;
    const consumidor = new ConsumidorComandos(sqs, execucoes, config, new MetricasService());

    await consumidor.processar({
      ReceiptHandle: 'rh',
      Body: JSON.stringify({
        ...criarEnvelope('AgendarExecucao', 'os-1', {}),
        traceparent: ORIGEM,
      }),
    });

    const [span] = exportador.getFinishedSpans();
    expect(span.name).toBe('processar AgendarExecucao');
    expect(span.spanContext().traceId).toBe(TRACE);
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    expect(evento!.traceparent).toBe(`00-${TRACE}-${span.spanContext().spanId}-01`);
  });

  it('a publicacao do outbox continua o trace guardado no item', async () => {
    const corpo = JSON.stringify({ type: 'ExecucaoFinalizada', traceparent: ORIGEM });
    ddb.on(QueryCommand).resolves({
      Items: [
        {
          pk: 'OUTBOX',
          sk: '1',
          tipo: 'ExecucaoFinalizada',
          fila: 'os-eventos',
          corpo,
          correlationId: 'os-1',
        },
      ],
    });
    ddb.on(DeleteCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({});

    await new PublicadorOutbox(
      db,
      sqs,
      'tabela',
      config,
      new MetricasService(),
    ).publicarPendentes();

    const [span] = exportador.getFinishedSpans();
    expect(span.name).toBe('publicar ExecucaoFinalizada');
    expect(span.spanContext().traceId).toBe(TRACE);
    expect(span.attributes['messaging.destination.name']).toBe('os-eventos');
    expect(sqsMock.commandCalls(SendMessageCommand)[0].args[0].input.MessageBody).toBe(corpo);
  });
});
