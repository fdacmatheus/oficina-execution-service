import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ConfigService } from '@nestjs/config';
import { mockClient } from 'aws-sdk-client-mock';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import { PublicadorOutbox } from './publicador-outbox';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const sqs = new SQSClient({ region: 'us-east-1' });
const ddb = mockClient(db);
const sqsMock = mockClient(sqs);

const item = (sk: string) => ({
  pk: 'OUTBOX',
  sk,
  tipo: 'ExecucaoFinalizada',
  fila: 'os-eventos',
  corpo: '{"type":"ExecucaoFinalizada"}',
  correlationId: 'os-1',
});

function criar(env: Record<string, string> = {}) {
  const config = new ConfigService({ SQS_OS_EVENTOS_URL: 'http://fila/os-eventos', ...env });
  return new PublicadorOutbox(db, sqs, 'tabela', config, new MetricasService());
}

describe('PublicadorOutbox', () => {
  beforeEach(() => {
    ddb.reset();
    sqsMock.reset();
    jest.useRealTimers();
  });

  it('envia cada item ao SQS com os atributos e so depois apaga', async () => {
    ddb.on(QueryCommand).resolves({ Items: [item('1'), item('2')] });
    sqsMock.on(SendMessageCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});

    await expect(criar().publicarPendentes()).resolves.toBe(2);

    const envio = sqsMock.commandCalls(SendMessageCommand)[0].args[0].input;
    expect(envio).toEqual({
      QueueUrl: 'http://fila/os-eventos',
      MessageBody: '{"type":"ExecucaoFinalizada"}',
      MessageAttributes: {
        type: { DataType: 'String', StringValue: 'ExecucaoFinalizada' },
        correlationId: { DataType: 'String', StringValue: 'os-1' },
      },
    });
    expect(ddb.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key)).toEqual([
      { pk: 'OUTBOX', sk: '1' },
      { pk: 'OUTBOX', sk: '2' },
    ]);
  });

  it('nao apaga o item se o envio falhar', async () => {
    ddb.on(QueryCommand).resolves({ Items: [item('1')] });
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs fora'));
    await expect(criar().publicarPendentes()).resolves.toBe(0);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('nao roda dois lotes ao mesmo tempo', async () => {
    ddb.on(QueryCommand).resolves({});
    const p = criar();
    const primeiro = p.publicarPendentes();
    await expect(p.publicarPendentes()).resolves.toBe(0);
    await primeiro;
  });

  it('agenda no bootstrap e para no shutdown', () => {
    jest.useFakeTimers();
    ddb.on(QueryCommand).resolves({});
    const p = criar({ OUTBOX_INTERVAL_MS: '500' });
    const publicar = jest.spyOn(p, 'publicarPendentes');
    p.onApplicationBootstrap();
    jest.advanceTimersByTime(1000);
    expect(publicar).toHaveBeenCalledTimes(2);
    p.onApplicationShutdown();
    jest.advanceTimersByTime(1000);
    expect(publicar).toHaveBeenCalledTimes(2);
  });

  it('pode ser desligado por env', () => {
    jest.useFakeTimers();
    const p = criar({ OUTBOX_PUBLISHER_ENABLED: 'false' });
    const publicar = jest.spyOn(p, 'publicarPendentes');
    p.onApplicationBootstrap();
    jest.advanceTimersByTime(5000);
    expect(publicar).not.toHaveBeenCalled();
  });
});
