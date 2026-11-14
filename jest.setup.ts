import { Logger } from '@nestjs/common';

// Silencia o logger do Nest nos testes; os testes de log usam spies no console.
Logger.overrideLogger(false);
