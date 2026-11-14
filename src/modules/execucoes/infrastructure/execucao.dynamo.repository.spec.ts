import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { criarEnvelope } from 'src/shared/mensageria/envelope';
import { Execucao } from '../domain/execucao.entity';
import { ConflitoConcorrenciaError, MensagemDuplicadaError } from '../domain/execucao.repository';
import { STATUS_ATIVOS, StatusExecucao } from '../domain/status-execucao';
import { ExecucaoDynamoRepository, ms13 } from './execucao.dynamo.repository';

const T0 = 1763121600000;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const ddb = mockClient(db);
const repo = new ExecucaoDynamoRepository(db, 'tabela');

const meta = {
  pk: 'EXEC#os-1',
  sk: 'META',
  execucaoId: 'e-1',
  osId: 'os-1',
  osNumero: 7,
  itens: [],
  status: 'EM_REPARO',
  enfileiradaEm: T0,
  atualizadaEm: T0 + 1000,
  versao: 3,
};

const cancelada = (...codigos: string[]) =>
  new TransactionCanceledException({
    message: 'cancelada',
    $metadata: {},
    CancellationReasons: codigos.map((Code) => ({ Code })),
  });

const evento = (osId: string) => ({
  fila: 'os-eventos',
  envelope: criarEnvelope('ExecucaoAgendada', osId, { osId }),
});

describe('ExecucaoDynamoRepository', () => {
  beforeEach(() => ddb.reset());

  it('ms13 completa com zeros ate 13 digitos', () => {
    expect(ms13(5)).toBe('0000000000005');
    expect(ms13(T0)).toBe('1763121600000');
  });

  describe('buscar', () => {
    it('monta a execucao com a linha do tempo (com paginacao)', async () => {
      ddb
        .on(QueryCommand)
        .resolvesOnce({
          Items: [meta],
          LastEvaluatedKey: { pk: 'EXEC#os-1', sk: 'META' },
        })
        .resolvesOnce({
          Items: [
            { pk: 'EXEC#os-1', sk: `EVT#${ms13(T0)}#u-1`, etapa: 'NA_FILA', em: T0 },
            {
              pk: 'EXEC#os-1',
              sk: `EVT#${ms13(T0 + 9)}#u-2`,
              etapa: 'EM_REPARO',
              observacao: 'x',
              em: T0 + 9,
            },
          ],
        });

      const e = (await repo.buscar('os-1'))!;
      expect(e).toMatchObject({ id: 'e-1', status: StatusExecucao.EM_REPARO, versao: 3 });
      expect(e.finalizadaEm).toBeUndefined();
      expect(e.linhaDoTempo).toEqual([
        { id: 'u-1', etapa: 'NA_FILA', em: T0, observacao: undefined },
        { id: 'u-2', etapa: 'EM_REPARO', em: T0 + 9, observacao: 'x' },
      ]);
      const consulta = ddb.commandCalls(QueryCommand)[0].args[0].input;
      expect(consulta).toMatchObject({
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'EXEC#os-1' },
        ConsistentRead: true,
      });
    });

    it('retorna null sem o item META', async () => {
      ddb.on(QueryCommand).resolves({});
      await expect(repo.buscar('nada')).resolves.toBeNull();
    });
  });

  it('lista por status no gsi1', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ ...meta, finalizadaEm: T0 + 5 }] });
    const lista = await repo.listarPorStatus([StatusExecucao.NA_FILA]);
    expect(lista[0].finalizadaEm).toBe(T0 + 5);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: 'gsi1',
      ExpressionAttributeValues: { ':pk': 'STATUS#NA_FILA' },
    });
  });

  it('conta por status com Select COUNT e paginacao', async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Count: 2, LastEvaluatedKey: { pk: 'x' } })
      .resolves({ Count: 1 });
    await expect(repo.contarPorStatus(STATUS_ATIVOS)).resolves.toEqual({
      NA_FILA: 3,
      EM_DIAGNOSTICO: 1,
      EM_REPARO: 1,
    });
  });

  it('conta quem esta a frente na fila', async () => {
    ddb.on(QueryCommand).resolves({});
    const e = Execucao.agendar({ osId: 'os-9' }, T0);
    await expect(repo.contarAFrente(e)).resolves.toBe(0);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk < :sk',
      ExpressionAttributeValues: { ':pk': 'STATUS#NA_FILA', ':sk': `${ms13(T0)}#os-9` },
    });
  });

  describe('persistir', () => {
    it('grava inbox, execucao nova, linha do tempo e outbox na mesma transacao', async () => {
      ddb.on(TransactWriteCommand).resolves({});
      const e = Execucao.agendar({ osId: 'os-1' }, T0);
      await repo.persistir({ execucao: e, mensagens: [evento('os-1')], mensagemRecebidaId: 'm-1' });

      const itens = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems!;
      expect(itens.map((i) => i.Put!.Item!.pk)).toEqual([
        'MSG#m-1',
        'EXEC#os-1',
        'EXEC#os-1',
        'OUTBOX',
      ]);
      expect(itens[0].Put!.ConditionExpression).toBe('attribute_not_exists(pk)');
      expect(itens[1].Put).toMatchObject({
        ConditionExpression: 'attribute_not_exists(pk)',
        Item: {
          gsi1pk: 'STATUS#NA_FILA',
          gsi1sk: `${ms13(T0)}#os-1`,
          versao: 1,
          enfileiradaEm: T0,
        },
      });
      expect(itens[2].Put!.Item!.sk).toMatch(new RegExp(`^EVT#${ms13(T0)}#`));
      expect(itens[3].Put!.Item).toMatchObject({
        tipo: 'ExecucaoAgendada',
        fila: 'os-eventos',
        correlationId: 'os-1',
      });
      expect(JSON.parse(itens[3].Put!.Item!.corpo as string).type).toBe('ExecucaoAgendada');
      expect(e.eventosNovos).toHaveLength(0);
    });

    it('atualiza com concorrencia otimista pela versao', async () => {
      ddb.on(TransactWriteCommand).resolves({});
      const e = new Execucao({ ...meta, id: 'e-1', status: StatusExecucao.EM_REPARO });
      e.finalizar(T0 + 60_000);
      await repo.persistir({ execucao: e, mensagens: [] });
      const put = ddb.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems![0].Put!;
      expect(put).toMatchObject({
        ConditionExpression: 'versao = :versao',
        ExpressionAttributeValues: { ':versao': 3 },
        Item: { versao: 4, status: 'FINALIZADA', finalizadaEm: T0 + 60_000 },
      });
    });

    it('condicao do inbox → MensagemDuplicadaError', async () => {
      ddb.on(TransactWriteCommand).rejects(cancelada('ConditionalCheckFailed', 'None'));
      await expect(
        repo.persistir({ mensagens: [evento('os-1')], mensagemRecebidaId: 'm-1' }),
      ).rejects.toThrow(MensagemDuplicadaError);
    });

    it('condicao da versao → ConflitoConcorrenciaError (com e sem inbox)', async () => {
      const e = Execucao.agendar({ osId: 'os-1' });
      ddb.on(TransactWriteCommand).rejects(cancelada('None', 'ConditionalCheckFailed'));
      await expect(
        repo.persistir({ execucao: e, mensagens: [], mensagemRecebidaId: 'm' }),
      ).rejects.toThrow(ConflitoConcorrenciaError);
      ddb.on(TransactWriteCommand).rejects(cancelada('ConditionalCheckFailed'));
      await expect(repo.persistir({ execucao: e, mensagens: [] })).rejects.toThrow(
        ConflitoConcorrenciaError,
      );
    });

    it('outros cancelamentos e erros sobem intactos', async () => {
      ddb.on(TransactWriteCommand).rejects(cancelada('ThrottlingError'));
      await expect(repo.persistir({ mensagens: [] })).rejects.toThrow('cancelada');
      ddb.on(TransactWriteCommand).rejects(new Error('rede'));
      await expect(repo.persistir({ mensagens: [] })).rejects.toThrow('rede');
      const semMotivos = new TransactionCanceledException({ message: 'sem', $metadata: {} });
      ddb.on(TransactWriteCommand).rejects(semMotivos);
      await expect(repo.persistir({ mensagens: [], mensagemRecebidaId: 'm' })).rejects.toThrow(
        'sem',
      );
    });
  });
});
