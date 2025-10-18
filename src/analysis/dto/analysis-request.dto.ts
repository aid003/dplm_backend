import { ApiProperty } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsBoolean,
  IsArray,
} from 'class-validator';

export enum AnalysisType {
  VULNERABILITY = 'VULNERABILITY',
  EXPLANATION = 'EXPLANATION',
  RECOMMENDATION = 'RECOMMENDATION',
  FULL = 'FULL',
}

export class AnalysisOptionsDto {
  @ApiProperty({
    description: 'Включать ли тестовые файлы в анализ',
    required: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  includeTests?: boolean = false;

  @ApiProperty({
    description: 'Список языков программирования для анализа',
    required: false,
    example: ['typescript', 'javascript', 'python'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];
}

export class AnalysisRequestDto {
  @ApiProperty({
    description: 'Тип анализа',
    enum: AnalysisType,
    example: AnalysisType.FULL,
  })
  @IsEnum(AnalysisType)
  type: AnalysisType;

  @ApiProperty({
    description: 'Путь к конкретному файлу для анализа (опционально)',
    required: false,
    example: 'src/app.controller.ts',
  })
  @IsOptional()
  @IsString()
  filePath?: string;

  @ApiProperty({
    description: 'Дополнительные опции анализа',
    required: false,
    type: AnalysisOptionsDto,
  })
  @IsOptional()
  options?: AnalysisOptionsDto;
}
