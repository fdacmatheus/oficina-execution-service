// Precisa vir antes de qualquer outro import para instrumentar as bibliotecas.
import './tracing';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './shared/filters/http-exception.filter';
import { LoggerService } from './shared/observabilidade/logger.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.useLogger(app.get(LoggerService));
  app.set('trust proxy', true);
  // Os hooks de shutdown param o consumidor SQS e o publicador do outbox.
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swagger = new DocumentBuilder()
    .setTitle('Oficina · execution-service')
    .setDescription('Fila de execução da OS, diagnóstico, reparo e linha do tempo')
    .setVersion('4.0.0')
    .addBearerAuth()
    // Atrás do API Gateway o serviço fica sob um prefixo (/os, /billing, /execution).
    .addServer(process.env.SWAGGER_PREFIXO ?? '/', 'Ambiente atual')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(config.get<number>('PORT', 3003), '0.0.0.0');
}

void bootstrap();
