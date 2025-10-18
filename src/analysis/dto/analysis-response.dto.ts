import { ApiProperty } from '@nestjs/swagger';
import { AnalysisType } from './analysis-request.dto';

export enum AnalysisStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum VulnSeverity {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  INFO = 'INFO',
}

export class AnalysisProgressDto {
  @ApiProperty({
    description: 'Текущий шаг выполнения',
    example: 'Scanning files',
  })
  currentStep: string;

  @ApiProperty({
    description: 'Процент выполнения (0-100)',
    example: 45,
  })
  percentage: number;

  @ApiProperty({
    description: 'Количество обработанных файлов',
    example: 23,
  })
  processedFiles: number;

  @ApiProperty({
    description: 'Общее количество файлов',
    example: 50,
  })
  totalFiles: number;

  @ApiProperty({
    description: 'Текущий обрабатываемый файл',
    required: false,
    example: 'src/app.controller.ts',
  })
  currentFile?: string;
}

export class VulnerabilityDto {
  @ApiProperty({
    description: 'ID уязвимости',
    example: 'uuid-string',
  })
  id: string;

  @ApiProperty({
    description: 'Серьезность уязвимости',
    enum: VulnSeverity,
    example: VulnSeverity.HIGH,
  })
  severity: VulnSeverity;

  @ApiProperty({
    description: 'Тип уязвимости',
    example: 'SQL_INJECTION',
  })
  type: string;

  @ApiProperty({
    description: 'Заголовок уязвимости',
    example: 'SQL Injection in user query',
  })
  title: string;

  @ApiProperty({
    description: 'Описание уязвимости',
    example:
      'User input is directly concatenated into SQL query without sanitization',
  })
  description: string;

  @ApiProperty({
    description: 'Путь к файлу',
    example: 'src/users/users.service.ts',
  })
  filePath: string;

  @ApiProperty({
    description: 'Начальная строка',
    example: 15,
  })
  lineStart: number;

  @ApiProperty({
    description: 'Конечная строка',
    example: 15,
  })
  lineEnd: number;

  @ApiProperty({
    description: 'Фрагмент кода с уязвимостью',
    example: 'const query = `SELECT * FROM users WHERE id = ${userId}`;',
  })
  codeSnippet: string;

  @ApiProperty({
    description: 'Рекомендация по исправлению',
    example: 'Use parameterized queries or prepared statements',
  })
  recommendation: string;

  @ApiProperty({
    description: 'CWE идентификатор',
    required: false,
    example: 'CWE-89',
  })
  cwe?: string;

  @ApiProperty({
    description: 'Дата создания',
    example: '2025-01-18T06:54:25.000Z',
  })
  createdAt: Date;
}

export class CodeExplanationDto {
  @ApiProperty({
    description: 'ID объяснения',
    example: 'uuid-string',
  })
  id: string;

  @ApiProperty({
    description: 'Путь к файлу',
    example: 'src/app.controller.ts',
  })
  filePath: string;

  @ApiProperty({
    description: 'Имя символа (функция/класс)',
    required: false,
    example: 'getHello',
  })
  symbolName?: string;

  @ApiProperty({
    description: 'Тип символа',
    required: false,
    example: 'function',
  })
  symbolType?: string;

  @ApiProperty({
    description: 'Начальная строка',
    example: 10,
  })
  lineStart: number;

  @ApiProperty({
    description: 'Конечная строка',
    example: 12,
  })
  lineEnd: number;

  @ApiProperty({
    description: 'Краткое описание',
    example: 'Returns a greeting message',
  })
  summary: string;

  @ApiProperty({
    description: 'Подробное объяснение от AI',
    example:
      'This function returns a simple greeting message using the AppService...',
  })
  detailed: string;

  @ApiProperty({
    description: 'Цикломатическая сложность',
    required: false,
    example: 1,
  })
  complexity?: number;

  @ApiProperty({
    description: 'Дата создания',
    example: '2025-01-18T06:54:25.000Z',
  })
  createdAt: Date;
}

export class AnalysisResultDto {
  @ApiProperty({
    description: 'Найденные уязвимости',
    type: [VulnerabilityDto],
    required: false,
  })
  vulnerabilities?: VulnerabilityDto[];

  @ApiProperty({
    description: 'Объяснения кода',
    type: [CodeExplanationDto],
    required: false,
  })
  explanations?: CodeExplanationDto[];

  @ApiProperty({
    description: 'Рекомендации по улучшению',
    required: false,
  })
  recommendations?: any[];
}

export class AnalysisReportDto {
  @ApiProperty({
    description: 'ID отчета',
    example: 'uuid-string',
  })
  id: string;

  @ApiProperty({
    description: 'ID проекта',
    example: 'uuid-string',
  })
  projectId: string;

  @ApiProperty({
    description: 'Тип анализа',
    enum: AnalysisType,
    example: AnalysisType.FULL,
  })
  type: AnalysisType;

  @ApiProperty({
    description: 'Статус анализа',
    enum: AnalysisStatus,
    example: AnalysisStatus.COMPLETED,
  })
  status: AnalysisStatus;

  @ApiProperty({
    description: 'Путь к файлу (если анализ конкретного файла)',
    required: false,
    example: 'src/app.controller.ts',
  })
  filePath?: string;

  @ApiProperty({
    description: 'Язык программирования',
    required: false,
    example: 'typescript',
  })
  language?: string;

  @ApiProperty({
    description: 'Результаты анализа',
    type: AnalysisResultDto,
  })
  result: AnalysisResultDto;

  @ApiProperty({
    description: 'Ошибка (если есть)',
    required: false,
    example: 'Failed to parse file',
  })
  error?: string;

  @ApiProperty({
    description: 'Прогресс выполнения',
    type: AnalysisProgressDto,
    required: false,
  })
  progress?: AnalysisProgressDto;

  @ApiProperty({
    description: 'Дата создания',
    example: '2025-01-18T06:54:25.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Дата обновления',
    example: '2025-01-18T06:54:25.000Z',
  })
  updatedAt: Date;
}

export class AnalysisStatusDto {
  @ApiProperty({
    description: 'ID отчета',
    example: 'uuid-string',
  })
  id: string;

  @ApiProperty({
    description: 'Статус анализа',
    enum: AnalysisStatus,
    example: AnalysisStatus.PROCESSING,
  })
  status: AnalysisStatus;

  @ApiProperty({
    description: 'Прогресс выполнения',
    type: AnalysisProgressDto,
  })
  progress: AnalysisProgressDto;

  @ApiProperty({
    description: 'Время начала',
    example: '2025-01-18T06:54:25.000Z',
  })
  startedAt: Date;

  @ApiProperty({
    description: 'Оценочное время до завершения (в секундах)',
    required: false,
    example: 120,
  })
  estimatedTimeRemaining?: number;
}

export class AnalysisHistoryDto {
  @ApiProperty({
    description: 'Список отчетов',
    type: [AnalysisReportDto],
  })
  reports: AnalysisReportDto[];

  @ApiProperty({
    description: 'Общее количество отчетов',
    example: 25,
  })
  total: number;

  @ApiProperty({
    description: 'Статистика анализов',
  })
  stats: {
    totalAnalyses: number;
    completedAnalyses: number;
    failedAnalyses: number;
    averageDuration: number;
  };
}
