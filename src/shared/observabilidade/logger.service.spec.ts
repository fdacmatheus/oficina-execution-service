import { contextoRequisicao } from './correlacao.middleware';
import { LoggerService } from './logger.service';

describe('LoggerService', () => {
  const original = process.env.LOG_FORMAT;
  let log: jest.SpyInstance;
  let erro: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    erro = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env.LOG_FORMAT = original;
    jest.restoreAllMocks();
  });

  it('em JSON inclui servico, nivel e correlationId', () => {
    process.env.LOG_FORMAT = 'json';
    const logger = new LoggerService();
    contextoRequisicao.run({ correlationId: 'os-1' }, () => logger.log('oi', 'Ctx'));
    const linha = JSON.parse(log.mock.calls[0][0]);
    expect(linha).toMatchObject({
      nivel: 'info',
      servico: 'oficina-execution-service',
      contexto: 'Ctx',
      correlationId: 'os-1',
      mensagem: 'oi',
    });
    expect(typeof linha.timestamp).toBe('number');

    logger.error({ a: 1 }, 'pilha');
    expect(JSON.parse(erro.mock.calls[0][0])).toMatchObject({
      nivel: 'error',
      detalhe: 'pilha',
      mensagem: '{"a":1}',
    });
    logger.warn('w');
    logger.debug('d');
    logger.verbose('v');
    expect(log).toHaveBeenCalledTimes(4);
  });

  it('fora de JSON escreve texto legivel', () => {
    process.env.LOG_FORMAT = 'texto';
    const logger = new LoggerService();
    contextoRequisicao.run({ correlationId: 'c' }, () => logger.warn('aviso', 'Ctx'));
    logger.log('sem contexto');
    expect(log.mock.calls[0][0]).toBe('WARN [Ctx] aviso (c)');
    expect(log.mock.calls[1][0]).toBe('INFO sem contexto');
    logger.error('falhou', 'pilha');
    logger.error('sem pilha');
    expect(erro.mock.calls[0][0]).toBe('ERROR falhou\npilha');
    expect(erro.mock.calls[1][0]).toBe('ERROR sem pilha');
  });
});
