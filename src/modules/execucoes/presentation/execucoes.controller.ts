import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/shared/auth/jwt.strategy';
import { ExecucoesService } from '../application/execucoes.service';
import type { Execucao } from '../domain/execucao.entity';
import { FalharDto, ObservacaoDto } from './dto/transicao.dto';

export function apresentar(e: Execucao, comLinhaDoTempo = false) {
  return {
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
    ...(comLinhaDoTempo && {
      linhaDoTempo: [...e.linhaDoTempo]
        .sort((a, b) => a.em - b.em)
        .map((ev) => ({ etapa: ev.etapa, observacao: ev.observacao, em: ev.em })),
    }),
  };
}

@ApiTags('execucoes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('execucoes')
export class ExecucoesController {
  constructor(private readonly execucoes: ExecucoesService) {}

  @Get('fila')
  @ApiOperation({ summary: 'Fila ativa: em andamento primeiro, depois por ordem de chegada' })
  async fila() {
    return (await this.execucoes.listarFila()).map((e) => apresentar(e));
  }

  @Get(':osId')
  @ApiOperation({ summary: 'Execução da OS com a linha do tempo' })
  @ApiResponse({ status: 404, description: 'Execução não encontrada' })
  async obter(@Param('osId') osId: string) {
    return apresentar(await this.execucoes.obter(osId), true);
  }

  @Post(':osId/diagnostico')
  @HttpCode(200)
  @ApiOperation({ summary: 'NA_FILA → EM_DIAGNOSTICO' })
  @ApiResponse({ status: 400, description: 'Transição inválida' })
  async diagnostico(@Param('osId') osId: string, @Body() dto: ObservacaoDto) {
    return apresentar(await this.execucoes.iniciarDiagnostico(osId, dto.observacao), true);
  }

  @Post(':osId/reparo')
  @HttpCode(200)
  @ApiOperation({ summary: 'EM_DIAGNOSTICO → EM_REPARO' })
  @ApiResponse({ status: 400, description: 'Transição inválida' })
  async reparo(@Param('osId') osId: string, @Body() dto: ObservacaoDto) {
    return apresentar(await this.execucoes.iniciarReparo(osId, dto.observacao), true);
  }

  @Post(':osId/finalizar')
  @HttpCode(200)
  @ApiOperation({ summary: 'EM_REPARO → FINALIZADA' })
  @ApiResponse({ status: 400, description: 'Transição inválida' })
  async finalizar(@Param('osId') osId: string) {
    return apresentar(await this.execucoes.finalizar(osId), true);
  }

  @Post(':osId/falhar')
  @HttpCode(200)
  @ApiOperation({ summary: 'EM_DIAGNOSTICO/EM_REPARO → FALHOU (dispara a compensação da saga)' })
  @ApiResponse({ status: 400, description: 'Transição inválida' })
  async falhar(@Param('osId') osId: string, @Body() dto: FalharDto) {
    return apresentar(await this.execucoes.falhar(osId, dto.motivo), true);
  }
}
