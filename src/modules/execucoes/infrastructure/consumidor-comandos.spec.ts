import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { mockClient } from 'aws-sdk-client-mock';
import { obterCorrelationId } from 'src/shared/observabilidade/correlacao.middleware';
import { MetricasService } from 'src/shared/observabilidade/metricas.service';
import type { ExecucoesService } from '../application/execucoes.service';
import { MensagemDuplicadaError } from '../domain/execucao.repository';
import { ConsumidorComandos } from './consumidor-comandos';

const URL = 'http://fila/execution-comandos';
const sqs = new SQSClient({ region: 'us-east-1' });
const sqsMock = mockClient(sqs);

const mensagem = (type: string, payload: object, messageId = 'm-1'): Message => ({
  ReceiptHandle: `rh-${messageId}`,
  Body: JSON.stringify({
    messageId,
    type,
    correlationId: 'os-1',
    occurredAt: 1,
    source: 'os-service',
    payload,
  }),
  MessageAttributes: {
    type: { DataType: 'String', StringValue: type },
    correlationId: { DataType: 'String', StringValue: 'os-1' },
  },
});

describe('ConsumidorComandos', () => {
  let execucoes: { agendar: jest.Mock; cancelar: jest.Mock };
  let consumidor: ConsumidorComandos;

  function criar(env: Record<string, string> = {}) {
    const config = new ConfigService({ SQS_EXECUTION_COMANDOS_URL: URL, ...env });
    return new ConsumidorComandos(
      sqs,
      execucoes as unknown as ExecucoesService,
      config,
      new MetricasService(),
    );
  }

  beforeEach(() => {
    sqsMock.reset();
    sqsMock.on(DeleteMessageCommand).resolves({});
    execucoes = { agendar: jest.fn(), cancelar: jest.fn() };
    consumidor = criar();
  });

  const apagadas = () =>
    sqsMock.commandCalls(DeleteMessageCommand).map((c) => c.args[0].input.ReceiptHandle);

  it('AgendarExecucao: chama o caso de uso com o correlationId no contexto e apaga', async () => {
    let correlacao: string | undefined;
    execucoes.agendar.mockImplementation(async () => {
      correlacao = obterCorrelationId();
    });
    await consumidor.processar(mensagem('AgendarExecucao', { osId: 'os-1' }));
    expect(execucoes.agendar).toHaveBeenCalledWith({ osId: 'os-1' }, 'm-1');
    expect(correlacao).toBe('os-1');
    expect(apagadas()).toEqual(['rh-m-1']);
  });

  it('CancelarExecucao: chama o caso de uso e apaga', async () => {
    await consumidor.processar(mensagem('CancelarExecucao', { osId: 'os-1', motivo: 'x' }));
    expect(execucoes.cancelar).toHaveBeenCalledWith({ osId: 'os-1', motivo: 'x' }, 'm-1');
    expect(apagadas()).toHaveLength(1);
  });

  it('duplicada: ignora e apaga', async () => {
    execucoes.agendar.mockRejectedValue(new MensagemDuplicadaError('m-1'));
    await consumidor.processar(mensagem('AgendarExecucao', { osId: 'os-1' }));
    expect(apagadas()).toHaveLength(1);
  });

  it.each([
    ['erro no caso de uso', mensagem('AgendarExecucao', {}), new Error('dynamo fora')],
    ['tipo desconhecido', mensagem('Outro', {}), undefined],
    ['corpo invalido', { ReceiptHandle: 'rh', Body: 'nao-json' }, undefined],
    ['sem messageId', mensagem('AgendarExecucao', {}, ''), undefined],
  ])('%s: nao apaga (volta para a fila / DLQ)', async (_caso, msg, erro) => {
    if (erro) execucoes.agendar.mockRejectedValue(erro);
    await consumidor.processar(msg as Message);
    expect(apagadas()).toHaveLength(0);
  });

  it('sem atributos nem corpo: usa valores padrao e nao apaga', async () => {
    await consumidor.processar({ ReceiptHandle: 'rh' });
    expect(apagadas()).toHaveLength(0);
  });

  it('consome um lote com long polling', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [
        mensagem('AgendarExecucao', { osId: 'a' }, 'a'),
        mensagem('AgendarExecucao', { osId: 'b' }, 'b'),
      ],
    });
    await consumidor.consumirLote();
    expect(sqsMock.commandCalls(ReceiveMessageCommand)[0].args[0].input).toMatchObject({
      QueueUrl: URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
    });
    expect(apagadas()).toEqual(['rh-a', 'rh-b']);
  });

  it('lote vazio nao faz nada', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({});
    await consumidor.consumirLote();
    expect(execucoes.agendar).not.toHaveBeenCalled();
  });

  it('inicia no bootstrap, sobrevive a erro de recebimento e para no shutdown', async () => {
    jest.useFakeTimers();
    sqsMock
      .on(ReceiveMessageCommand)
      .rejectsOnce(new Error('rede'))
      .callsFake(async () => {
        void consumidor.onApplicationShutdown(); // um lote e encerra
        return { Messages: [mensagem('AgendarExecucao', { osId: 'a' }, 'a')] };
      });
    consumidor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5000);
    await consumidor.onApplicationShutdown();
    jest.useRealTimers();
    expect(sqsMock.commandCalls(ReceiveMessageCommand).length).toBeGreaterThanOrEqual(2);
    expect(execucoes.agendar).toHaveBeenCalled();
  });

  it('erro apos o shutdown encerra o laco', async () => {
    sqsMock.on(ReceiveMessageCommand).callsFake(async () => {
      void consumidor.onApplicationShutdown();
      throw new Error('abortado');
    });
    consumidor.onApplicationBootstrap();
    await consumidor.onApplicationShutdown();
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(1);
  });

  it('pode ser desligado por env', async () => {
    const c = criar({ SQS_CONSUMER_ENABLED: 'false' });
    c.onApplicationBootstrap();
    await c.onApplicationShutdown();
    expect(sqsMock.commandCalls(ReceiveMessageCommand)).toHaveLength(0);
  });
});
