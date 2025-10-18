import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min } from 'class-validator';

export class ExplainRequestDto {
  @ApiProperty({
    description: 'Путь к файлу для объяснения',
    example: 'src/app.controller.ts',
  })
  @IsString()
  filePath: string;

  @ApiProperty({
    description: 'Начальная строка (опционально)',
    required: false,
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  lineStart?: number;

  @ApiProperty({
    description: 'Конечная строка (опционально)',
    required: false,
    example: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  lineEnd?: number;

  @ApiProperty({
    description: 'Имя конкретной функции/класса для объяснения (опционально)',
    required: false,
    example: 'getHello',
  })
  @IsOptional()
  @IsString()
  symbolName?: string;
}
