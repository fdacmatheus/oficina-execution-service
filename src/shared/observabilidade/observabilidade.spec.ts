import { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { of } from 'rxjs';
import { HttpExceptionFilter } from '../filters/http-exception.filter';
import { MetricasInterceptor } from './metricas.interceptor';
import { MetricasService } from './metricas.service';

const next: CallHandler = { handle: () => of('ok') };

function contextoHttp(req: object, res: object): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('MetricasInterceptor', () => {
  it('ignora contexto que nao e HTTP', () => {
    const metricas = new MetricasService();
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    expect(new MetricasInterceptor(metricas).intercept(ctx, next)).toBeDefined();
  });

  it('usa o path quando nao ha rota registrada', async () => {
    const metricas = new MetricasService();
    const res = Object.assign(new EventEmitter(), { statusCode: 204 });
    new MetricasInterceptor(metricas).intercept(
      contextoHttp({ method: 'GET', path: '/api/x' }, res),
      next,
    );
    res.emit('finish');
    const texto = await metricas.expor();
    expect(texto).toContain('http_requests_total{method="GET",route="/api/x",status="204"} 1');
  });
});

describe('MetricasService', () => {
  it('sem fonte da fila o gauge fica vazio', async () => {
    const metricas = new MetricasService();
    metricas.onModuleInit();
    expect(await metricas.expor()).not.toContain('oficina_execucao_fila_tamanho{');
    expect(metricas.contentType).toContain('text/plain');
  });
});

describe('HttpExceptionFilter', () => {
  it('excecao que nao e Error vira 500', () => {
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ method: 'GET', url: '/api/x' }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch('falhou', host);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500, path: '/api/x' }));
  });
});
