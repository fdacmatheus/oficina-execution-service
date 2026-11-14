import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ObservacaoDto {
  @ApiPropertyOptional({ example: 'Ruído na suspensão dianteira', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacao?: string;
}

export class FalharDto {
  @ApiProperty({ example: 'Peça incompatível com o veículo', maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  motivo!: string;
}
