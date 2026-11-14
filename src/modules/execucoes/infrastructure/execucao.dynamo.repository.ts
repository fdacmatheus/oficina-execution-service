import type { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventoLinhaDoTempo, Execucao } from '../domain/execucao.entity';
import {
  Alteracao,
  ConflitoConcorrenciaError,
  ExecucaoRepository,
  MensagemDuplicadaError,
} from '../domain/execucao.repository';
import { StatusExecucao } from '../domain/status-execucao';

export const DYNAMODB_TABLE = 'DYNAMODB_TABLE';

/** Itens de inbox expiram (TTL) depois de 7 dias; o SQS nao reentrega tanto tempo depois. */
const TTL_INBOX_SEGUNDOS = 7 * 24 * 3600;

type Item = Record<string, unknown>;

/** Epoch ms com zeros a esquerda (13 digitos), para ordenar como string. */
export const ms13 = (ms: number) => String(ms).padStart(13, '0');

export const chaves = {
  execucao: (osId: string) => `EXEC#${osId}`,
  meta: 'META',
  evento: (e: EventoLinhaDoTempo) => `EVT#${ms13(e.em)}#${e.id}`,
  status: (s: StatusExecucao) => `STATUS#${s}`,
  ordemFila: (e: Execucao) => `${ms13(e.enfileiradaEm)}#${e.osId}`,
  mensagem: (id: string) => `MSG#${id}`,
  outbox: 'OUTBOX',
};

/**
 * Tabela unica `oficina-execucoes`. Ver o README para o desenho das chaves e os
 * padroes de acesso.
 */
@Injectable()
export class ExecucaoDynamoRepository implements ExecucaoRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    @Inject(DYNAMODB_TABLE) private readonly tabela: string,
  ) {}

  async buscar(osId: string): Promise<Execucao | null> {
    const itens = await this.consultarTudo({
      TableName: this.tabela,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': chaves.execucao(osId) },
      ConsistentRead: true,
    });
    const meta = itens.find((i) => i.sk === chaves.meta);
    if (!meta) return null;
    const eventos = itens.filter((i) => String(i.sk).startsWith('EVT#')).map(paraEvento);
    return paraExecucao(meta, eventos);
  }

  async listarPorStatus(status: readonly StatusExecucao[]): Promise<Execucao[]> {
    const grupos = await Promise.all(status.map((s) => this.consultarTudo(this.consultaStatus(s))));
    return grupos.flat().map((i) => paraExecucao(i, []));
  }

  async contarPorStatus(status: readonly StatusExecucao[]): Promise<Record<string, number>> {
    const totais = await Promise.all(
      status.map((s) => this.contar({ ...this.consultaStatus(s), Select: 'COUNT' })),
    );
    return Object.fromEntries(status.map((s, i) => [s, totais[i]]));
  }

  contarAFrente(execucao: Execucao): Promise<number> {
    return this.contar({
      TableName: this.tabela,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk < :sk',
      ExpressionAttributeValues: {
        ':pk': chaves.status(StatusExecucao.NA_FILA),
        ':sk': chaves.ordemFila(execucao),
      },
      Select: 'COUNT',
    });
  }

  async persistir({ execucao, mensagens, mensagemRecebidaId }: Alteracao): Promise<void> {
    const agora = Date.now();
    const itens: NonNullable<TransactWriteCommand['input']['TransactItems']> = [];

    // Inbox sempre na posicao 0: e por ela que se reconhece a duplicata.
    if (mensagemRecebidaId) {
      itens.push({
        Put: {
          TableName: this.tabela,
          Item: {
            pk: chaves.mensagem(mensagemRecebidaId),
            sk: 'MSG',
            processadaEm: agora,
            ttl: Math.floor(agora / 1000) + TTL_INBOX_SEGUNDOS,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }

    if (execucao) {
      itens.push({
        Put: {
          TableName: this.tabela,
          Item: paraItem(execucao),
          ...(execucao.versao === 0
            ? { ConditionExpression: 'attribute_not_exists(pk)' }
            : {
                ConditionExpression: 'versao = :versao',
                ExpressionAttributeValues: { ':versao': execucao.versao },
              }),
        },
      });
      for (const evento of execucao.eventosNovos) {
        itens.push({
          Put: {
            TableName: this.tabela,
            Item: {
              pk: chaves.execucao(execucao.osId),
              sk: chaves.evento(evento),
              tipoItem: 'EVENTO',
              etapa: evento.etapa,
              observacao: evento.observacao,
              em: evento.em,
            },
          },
        });
      }
    }

    for (const { fila, envelope } of mensagens) {
      itens.push({
        Put: {
          TableName: this.tabela,
          Item: {
            pk: chaves.outbox,
            sk: `${ms13(agora)}#${randomUUID()}`,
            criadoEm: agora,
            tipo: envelope.type,
            fila,
            corpo: JSON.stringify(envelope),
            correlationId: envelope.correlationId,
          },
        },
      });
    }

    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: itens }));
    } catch (erro) {
      if ((erro as Error).name !== 'TransactionCanceledException') throw erro;
      const motivos = (erro as TransactionCanceledException).CancellationReasons ?? [];
      const falhou = (i: number) => motivos[i]?.Code === 'ConditionalCheckFailed';
      if (mensagemRecebidaId && falhou(0)) throw new MensagemDuplicadaError(mensagemRecebidaId);
      if (execucao && falhou(mensagemRecebidaId ? 1 : 0)) {
        throw new ConflitoConcorrenciaError(execucao.osId);
      }
      throw erro;
    }
    execucao?.eventosNovos.splice(0);
  }

  private consultaStatus(status: StatusExecucao): QueryCommandInput {
    return {
      TableName: this.tabela,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': chaves.status(status) },
    };
  }

  private async consultarTudo(entrada: QueryCommandInput): Promise<Item[]> {
    const itens: Item[] = [];
    let inicio: Item | undefined;
    do {
      const r = await this.db.send(new QueryCommand({ ...entrada, ExclusiveStartKey: inicio }));
      itens.push(...(r.Items ?? []));
      inicio = r.LastEvaluatedKey;
    } while (inicio);
    return itens;
  }

  private async contar(entrada: QueryCommandInput): Promise<number> {
    let total = 0;
    let inicio: Item | undefined;
    do {
      const r = await this.db.send(new QueryCommand({ ...entrada, ExclusiveStartKey: inicio }));
      total += r.Count ?? 0;
      inicio = r.LastEvaluatedKey;
    } while (inicio);
    return total;
  }
}

function paraItem(e: Execucao): Item {
  return {
    pk: chaves.execucao(e.osId),
    sk: chaves.meta,
    gsi1pk: chaves.status(e.status),
    gsi1sk: chaves.ordemFila(e),
    tipoItem: 'EXECUCAO',
    execucaoId: e.id,
    osId: e.osId,
    osNumero: e.osNumero,
    veiculo: e.veiculo,
    itens: e.itens,
    status: e.status,
    enfileiradaEm: e.enfileiradaEm,
    atualizadaEm: e.atualizadaEm,
    finalizadaEm: e.finalizadaEm,
    motivo: e.motivo,
    versao: e.versao + 1,
  };
}

function paraExecucao(i: Item, linhaDoTempo: EventoLinhaDoTempo[]): Execucao {
  return new Execucao({
    id: i.execucaoId as string,
    osId: i.osId as string,
    osNumero: i.osNumero as number | string | undefined,
    veiculo: i.veiculo as Execucao['veiculo'],
    itens: i.itens as Execucao['itens'],
    status: i.status as StatusExecucao,
    enfileiradaEm: i.enfileiradaEm as number,
    atualizadaEm: i.atualizadaEm as number,
    finalizadaEm: i.finalizadaEm as number | undefined,
    motivo: i.motivo as string | undefined,
    versao: i.versao as number,
    linhaDoTempo,
  });
}

function paraEvento(i: Item): EventoLinhaDoTempo {
  const sk = String(i.sk);
  return {
    id: sk.slice(sk.lastIndexOf('#') + 1),
    etapa: i.etapa as StatusExecucao,
    observacao: i.observacao as string | undefined,
    em: i.em as number,
  };
}
