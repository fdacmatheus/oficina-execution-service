import { INestApplication, MiddlewareConsumer, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import request from 'supertest';
import { NotFoundException } from '@nestjs/common';
import { ExecucoesService } from './modules/execucoes/application/execucoes.service';
import { Execucao } from './modules/execucoes/domain/execucao.entity';
import { ExecucoesController } from './modules/execucoes/presentation/execucoes.controller';
import { JwtStrategy } from './shared/auth/jwt.strategy';
import { HttpExceptionFilter } from './shared/filters/http-exception.filter';
import { HealthController } from './shared/health/health.controller';
import { CorrelacaoMiddleware } from './shared/observabilidade/correlacao.middleware';
import { MetricasInterceptor } from './shared/observabilidade/metricas.interceptor';
import { MetricasService } from './shared/observabilidade/metricas.service';
import { ObservabilidadeModule } from './shared/observabilidade/observabilidade.module';

const SEGREDO = 'segredo-de-teste';
const T0 = 1763121600000;

function execucao(osId = 'os-1') {
  const e = Execucao.agendar({ osId, osNumero: 1 }, T0);
  e.iniciarDiagnostico('ruído', T0 + 10);
  return e;
}

const service = {
  listarFila: jest.fn(async () => [execucao()]),
  obter: jest.fn(async (osId: string) => {
    if (osId === 'nada') throw new NotFoundException('não encontrada');
    return execucao(osId);
  }),
  iniciarDiagnostico: jest.fn(async () => execucao()),
  iniciarReparo: jest.fn(async () => execucao()),
  finalizar: jest.fn(async () => execucao()),
  falhar: jest.fn(async () => {
    throw new Error('inesperado');
  }),
};

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ JWT_SECRET: SEGREDO })] }),
    ObservabilidadeModule,
    PassportModule,
  ],
  controllers: [HealthController, ExecucoesController],
  providers: [
    JwtStrategy,
    { provide: ExecucoesService, useValue: service },
    { provide: APP_INTERCEPTOR, useClass: MetricasInterceptor },
  ],
})
class AppTesteModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelacaoMiddleware).forRoutes('{*path}');
  }
}

describe('HTTP (controller, auth, filtro, observabilidade)', () => {
  let app: INestApplication;
  const token = sign({ sub: 'mecanico' }, SEGREDO, { algorithm: 'HS256', expiresIn: '5m' });
  const auth = { Authorization: `Bearer ${token}` };

  beforeAll(async () => {
    const ref = await Test.createTestingModule({ imports: [AppTesteModule] }).compile();
    app = ref.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(() => app.close());

  it('health e publico', async () => {
    const r = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(r.body.status).toBe('ok');
  });

  it('rotas exigem JWT', async () => {
    await request(app.getHttpServer()).get('/api/execucoes/fila').expect(401);
    const outro = sign({ sub: 'x' }, 'outro-segredo');
    await request(app.getHttpServer())
      .get('/api/execucoes/fila')
      .set('Authorization', `Bearer ${outro}`)
      .expect(401);
  });

  it('GET fila sem linha do tempo, datas em epoch ms', async () => {
    const r = await request(app.getHttpServer()).get('/api/execucoes/fila').set(auth).expect(200);
    expect(r.body[0]).toMatchObject({ osId: 'os-1', status: 'EM_DIAGNOSTICO', enfileiradaEm: T0 });
    expect(r.body[0].linhaDoTempo).toBeUndefined();
  });

  it('GET :osId com linha do tempo e correlationId propagado', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/execucoes/os-7')
      .set(auth)
      .set('x-correlation-id', 'corr-1')
      .expect(200);
    expect(r.headers['x-correlation-id']).toBe('corr-1');
    expect(r.body.linhaDoTempo).toEqual([
      { etapa: 'NA_FILA', em: T0 },
      { etapa: 'EM_DIAGNOSTICO', observacao: 'ruído', em: T0 + 10 },
    ]);
  });

  it('404 no formato do filtro', async () => {
    const r = await request(app.getHttpServer()).get('/api/execucoes/nada').set(auth).expect(404);
    expect(r.body).toMatchObject({ statusCode: 404, path: '/api/execucoes/nada' });
    expect(typeof r.body.timestamp).toBe('number');
  });

  it('POSTs de transicao', async () => {
    const s = request(app.getHttpServer());
    await s.post('/api/execucoes/os-1/diagnostico').set(auth).send({ observacao: 'a' }).expect(200);
    expect(service.iniciarDiagnostico).toHaveBeenCalledWith('os-1', 'a');
    await s.post('/api/execucoes/os-1/reparo').set(auth).send({}).expect(200);
    expect(service.iniciarReparo).toHaveBeenCalledWith('os-1', undefined);
    await s.post('/api/execucoes/os-1/finalizar').set(auth).expect(200);
    await s.post('/api/execucoes/os-1/falhar').set(auth).send({}).expect(400);
    await s.post('/api/execucoes/os-1/diagnostico').set(auth).send({ extra: 1 }).expect(400);
  });

  it('erro inesperado vira 500', async () => {
    await request(app.getHttpServer())
      .post('/api/execucoes/os-1/falhar')
      .set(auth)
      .send({ motivo: 'x' })
      .expect(500);
  });

  it('expoe as metricas Prometheus', async () => {
    app.get(MetricasService).fonteTamanhoFila = async () => ({ NA_FILA: 4 });
    const r = await request(app.getHttpServer()).get('/api/metrics').expect(200);
    expect(r.text).toContain('oficina_execucao_fila_tamanho{status="NA_FILA"} 4');
    expect(r.text).toMatch(
      /http_requests_total\{method="GET",route="\/api\/execucoes\/:osId",status="404"\} 1/,
    );
  });
});
