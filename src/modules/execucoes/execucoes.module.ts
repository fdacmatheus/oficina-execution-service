import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from 'src/shared/auth/jwt.strategy';
import { ExecucoesService } from './application/execucoes.service';
import { EXECUCAO_REPOSITORY } from './domain/execucao.repository';
import { ConsumidorComandos } from './infrastructure/consumidor-comandos';
import {
  DYNAMODB_TABLE,
  ExecucaoDynamoRepository,
} from './infrastructure/execucao.dynamo.repository';
import { PublicadorOutbox } from './infrastructure/publicador-outbox';
import { ExecucoesController } from './presentation/execucoes.controller';

// Os clientes AWS leem AWS_REGION, AWS_ENDPOINT_URL e as credenciais do
// ambiente (no EKS, do perfil da instancia).
@Module({
  imports: [PassportModule],
  controllers: [ExecucoesController],
  providers: [
    {
      provide: DynamoDBDocumentClient,
      useFactory: () =>
        DynamoDBDocumentClient.from(new DynamoDBClient({}), {
          marshallOptions: { removeUndefinedValues: true },
        }),
    },
    { provide: SQSClient, useFactory: () => new SQSClient({}) },
    {
      provide: DYNAMODB_TABLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get('DYNAMODB_TABLE', 'oficina-execucoes'),
    },
    { provide: EXECUCAO_REPOSITORY, useClass: ExecucaoDynamoRepository },
    ExecucoesService,
    ConsumidorComandos,
    PublicadorOutbox,
    JwtStrategy,
  ],
})
export class ExecucoesModule {}
