import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ExecucoesModule } from './modules/execucoes/execucoes.module';
import { HealthController } from './shared/health/health.controller';
import { CorrelacaoMiddleware } from './shared/observabilidade/correlacao.middleware';
import { MetricasInterceptor } from './shared/observabilidade/metricas.interceptor';
import { ObservabilidadeModule } from './shared/observabilidade/observabilidade.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    ObservabilidadeModule,
    ExecucoesModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: MetricasInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelacaoMiddleware).forRoutes('{*path}');
  }
}
