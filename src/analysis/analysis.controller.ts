import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../generated/prisma';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalysisService } from './analysis.service';
import { VulnerabilityService } from './vulnerability/vulnerability.service';
import { ExplanationService } from './explanation/explanation.service';
import { RecommendationsService } from './recommendations/recommendations.service';
import { SemanticSearchService } from './explanation/semantic-search.service';
import { AnalysisRequestDto, AnalysisType } from './dto/analysis-request.dto';
import {
  AnalysisReportDto,
  AnalysisStatusDto,
  AnalysisHistoryDto,
  VulnerabilityDto,
  CodeExplanationDto,
  AnalysisResultDto,
  RecommendationDto,
  RecommendationsResponseDto,
} from './dto/analysis-response.dto';
import { ExplainRequestDto } from './dto/explain-request.dto';
import {
  AnalysisStatus,
  AnalysisProgressDto,
  VulnSeverity,
} from './dto/analysis-response.dto';
import { getLogLevel } from './utils/environment.util';

interface AnalysisReport {
  id: string;
  projectId: string;
  status: AnalysisStatus;
  progress: AnalysisProgressDto | null;
  type: string;
  filePath: string;
  language: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AnalysisHistoryResult {
  reports: AnalysisReport[];
  total: number;
  stats: {
    totalAnalyses: number;
    completedAnalyses: number;
    failedAnalyses: number;
    averageDuration: number;
  };
}

interface VulnerabilityResult {
  vulnerabilities: Array<{
    id: string;
    severity: string;
    type: string;
    title: string;
    description: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    codeSnippet: string;
    recommendation: string;
    cwe: string;
    createdAt: Date;
  }>;
  stats: Record<string, unknown>;
}

@ApiTags('analysis')
@Controller('analysis')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AnalysisController {
  private readonly logger = new Logger(AnalysisController.name);

  constructor(
    private readonly analysisService: AnalysisService,
    private readonly vulnerabilityService: VulnerabilityService,
    private readonly explanationService: ExplanationService,
    private readonly recommendationsService: RecommendationsService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {}

  @Post('projects/:projectId/analyze')
  @ApiOperation({ summary: 'Запустить анализ проекта' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({
    description: 'Анализ запущен',
    type: AnalysisReportDto,
  })
  @ApiBadRequestResponse({ description: 'Неверные параметры запроса' })
  @ApiNotFoundResponse({ description: 'Проект не найден' })
  @ApiUnauthorizedResponse({ description: 'Не авторизован' })
  async startAnalysis(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: AnalysisRequestDto,
  ): Promise<{ reportId: string; status: string }> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(
      `Запрос на запуск анализа проекта ${projectId} от пользователя ${req.user.id}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры запроса анализа:', {
        userId: req.user.id,
        projectId,
        type: body.type,
        options: body.options,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
    }

    try {
      const report = await this.analysisService.startAnalysis(
        req.user.id,
        projectId,
        body.type,
        body.options || {},
        body.query,
      );

      const duration = Date.now() - startTime;
      this.logger.log(`Анализ ${report.id} запущен за ${duration}ms`);

      return {
        reportId: report.id,
        status: report.status,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при запуске анализа проекта ${projectId} (${duration}ms):`,
        error,
      );
      throw error;
    }
  }

  @Get('reports/:reportId')
  @ApiOperation({ summary: 'Получить результаты анализа' })
  @ApiParam({
    name: 'reportId',
    description: 'ID отчета анализа',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({
    description: 'Результаты анализа',
    type: AnalysisReportDto,
  })
  @ApiNotFoundResponse({ description: 'Отчет не найден' })
  async getAnalysisResults(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ): Promise<AnalysisReportDto> {
    const startTime = Date.now();
    this.logger.log(`Запрос результатов анализа ${reportId}`);

    try {
      const report = await this.analysisService.getAnalysisStatus(reportId);
      const duration = Date.now() - startTime;
      this.logger.log(
        `Результаты анализа ${reportId} получены за ${duration}ms`,
      );
      return this.mapReportToDto(report as unknown as AnalysisReport);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при получении результатов анализа ${reportId} (${duration}ms):`,
        error,
      );
      throw error;
    }
  }

  @Get('reports/:reportId/status')
  @ApiOperation({ summary: 'Получить статус анализа' })
  @ApiParam({
    name: 'reportId',
    description: 'ID отчета анализа',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({
    description: 'Статус анализа',
    type: AnalysisStatusDto,
  })
  @ApiNotFoundResponse({ description: 'Отчет не найден' })
  async getAnalysisStatus(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ): Promise<AnalysisStatusDto> {
    const report = (await this.analysisService.getAnalysisStatus(
      reportId,
    )) as AnalysisReport;

    return {
      id: report.id,
      status: report.status,
      progress: report.progress || {
        currentStep: 'Initializing',
        percentage: 0,
        processedFiles: 0,
        totalFiles: 0,
      },
      startedAt: report.createdAt,
      estimatedTimeRemaining: this.calculateEstimatedTime(report),
    };
  }

  @Post('reports/:reportId/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отменить анализ' })
  @ApiParam({
    name: 'reportId',
    description: 'ID отчета анализа',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({
    description: 'Анализ отменен',
    schema: {
      type: 'object',
      properties: { success: { type: 'boolean' }, message: { type: 'string' } },
    },
  })
  async cancelAnalysis(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
  ): Promise<{ success: boolean; message: string }> {
    const success = await this.analysisService.cancelAnalysis(reportId);

    return {
      success,
      message: success ? 'Анализ отменен' : 'Не удалось отменить анализ',
    };
  }

  @Get('projects/:projectId/reports')
  @ApiOperation({ summary: 'Получить историю анализов проекта' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({ name: 'type', required: false, enum: AnalysisType })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({
    description: 'История анализов',
    type: AnalysisHistoryDto,
  })
  async getProjectAnalysisHistory(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('type') type?: AnalysisType,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ): Promise<AnalysisHistoryDto> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(
      `Запрос истории анализов проекта ${projectId} от пользователя ${req.user.id}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры запроса истории:', {
        userId: req.user.id,
        projectId,
        type,
        status,
        limit,
        offset,
      });
    }

    try {
      const result = (await this.analysisService.getProjectAnalysisHistory(
        req.user.id,
        projectId,
        { type, status: status as AnalysisStatus | undefined, limit, offset },
      )) as AnalysisHistoryResult;

      const duration = Date.now() - startTime;
      this.logger.log(
        `История анализов проекта ${projectId} получена за ${duration}ms: найдено ${result.total} отчетов`,
      );

      return {
        reports: result.reports.map((report) => this.mapReportToDto(report)),
        total: result.total,
        stats: result.stats,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при получении истории анализов проекта ${projectId} (${duration}ms):`,
        error,
      );
      throw error;
    }
  }

  @Get('projects/:projectId/vulnerabilities')
  @ApiOperation({ summary: 'Получить уязвимости проекта' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({ name: 'severity', required: false })
  @ApiQuery({ name: 'filePath', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiOkResponse({
    description: 'Список уязвимостей',
    schema: {
      type: 'object',
      properties: {
        vulnerabilities: {
          type: 'array',
          items: { $ref: '#/components/schemas/VulnerabilityDto' },
        },
        stats: { type: 'object' },
      },
    },
  })
  async getVulnerabilities(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('severity') severity?: string,
    @Query('filePath') filePath?: string,
    @Query('type') type?: string,
  ): Promise<{ vulnerabilities: VulnerabilityDto[]; stats: any }> {
    const result = (await this.vulnerabilityService.getVulnerabilities(
      req.user.id,
      projectId,
      { severity: severity as VulnSeverity | undefined, filePath, type },
    )) as unknown as VulnerabilityResult;

    return {
      vulnerabilities: result.vulnerabilities.map((vuln) =>
        this.mapVulnerabilityToDto(vuln),
      ),
      stats: result.stats,
    };
  }

  @Post('projects/:projectId/explain')
  @ApiOperation({ summary: 'Объяснить код' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({
    description: 'Объяснение кода',
    type: CodeExplanationDto,
  })
  async explainCode(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() body: ExplainRequestDto,
  ): Promise<CodeExplanationDto> {
    this.logger.log(
      `Запрос объяснения кода: проект ${projectId}, файл ${body.filePath}, символ ${body.symbolName}`,
    );
    try {
      this.logger.log(`Вызываем explanationService.explainSymbol...`);
      const explanation = await this.explanationService.explainSymbol(
        req.user.id,
        projectId,
        body.filePath,
        body.symbolName || '',
        { includeComplexity: true },
      );
      this.logger.log(`explanationService.explainSymbol завершен`);

      if (!explanation || !explanation.explanation) {
        throw new Error('Не удалось получить объяснение');
      }

      const explanationText = explanation.explanation as string;

      return {
        explanation: explanationText,
      };
    } catch (error: unknown) {
      this.logger.error('Ошибка при генерации объяснения:', error);
      throw error instanceof Error ? error : new Error('Неизвестная ошибка');
    }
  }

  @Get('projects/:projectId/explanations')
  @ApiOperation({ summary: 'Получить объяснения кода проекта' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({ name: 'filePath', required: false })
  @ApiQuery({ name: 'symbolType', required: false })
  @ApiQuery({ name: 'symbolName', required: false })
  @ApiOkResponse({
    description: 'Список объяснений',
    type: [CodeExplanationDto],
  })
  async getExplanations(): Promise<CodeExplanationDto[]> {
    // Этот endpoint больше не поддерживается в новом формате
    // Возвращаем пустой массив или можно удалить endpoint
    return Promise.resolve([]);
  }

  @Get('projects/:projectId/recommendations')
  @ApiOperation({ summary: 'Получить рекомендации проекта' })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description:
      'Категория рекомендации (например: performance, security, code-quality)',
    example: 'performance',
  })
  @ApiQuery({
    name: 'priority',
    required: false,
    enum: ['HIGH', 'MEDIUM', 'LOW'],
    description: 'Приоритет рекомендации',
    example: 'HIGH',
  })
  @ApiQuery({
    name: 'filePath',
    required: false,
    description: 'Путь к файлу для фильтрации рекомендаций',
    example: 'src/app.controller.ts',
  })
  @ApiOkResponse({
    description: 'Список рекомендаций с статистикой',
    type: RecommendationsResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Проект не найден или нет завершенных анализов',
  })
  @ApiUnauthorizedResponse({ description: 'Не авторизован' })
  async getRecommendations(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('category') category?: string,
    @Query('priority') priority?: 'HIGH' | 'MEDIUM' | 'LOW',
    @Query('filePath') filePath?: string,
  ): Promise<RecommendationsResponseDto> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(
      `Запрос рекомендаций проекта ${projectId} от пользователя ${req.user.id}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры запроса рекомендаций:', {
        userId: req.user.id,
        projectId,
        category,
        priority,
        filePath,
      });
    }

    try {
      const result =
        await this.recommendationsService.getRecommendationsForProject(
          req.user.id,
          projectId,
          { category, priority, filePath },
        );

      const duration = Date.now() - startTime;
      this.logger.log(
        `Рекомендации проекта ${projectId} получены за ${duration}ms: ${result.recommendations.length} рекомендаций`,
      );

      return {
        recommendations: result.recommendations.map((rec) =>
          this.mapRecommendationToDto(rec),
        ),
        stats: result.stats,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при получении рекомендаций проекта ${projectId} (${duration}ms):`,
        error,
      );
      throw error;
    }
  }

  @Get('projects/:projectId/index/status')
  @ApiOperation({
    summary: 'Получить статус индекса файлов проекта в Weaviate',
  })
  @ApiParam({
    name: 'projectId',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({
    description: 'Статус индекса',
    schema: {
      type: 'object',
      properties: {
        totalFiles: { type: 'number' },
        lastIndexed: { type: 'string', format: 'date-time', nullable: true },
        languages: { type: 'object' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Проект не найден' })
  @ApiUnauthorizedResponse({ description: 'Не авторизован' })
  async getIndexStatus(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ): Promise<{
    totalFiles: number;
    lastIndexed: string | null;
    languages: Record<string, number>;
  }> {
    const startTime = Date.now();

    this.logger.log(
      `Запрос статуса индекса проекта ${projectId} от пользователя ${req.user.id}`,
    );

    try {
      // Проверяем права доступа к проекту
      await this.analysisService.getProjectAnalysisHistory(
        req.user.id,
        projectId,
        { limit: 1 },
      );

      const status = await this.semanticSearchService.getIndexStatus(projectId);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Статус индекса проекта ${projectId} получен за ${duration}ms: ${status.totalFiles} файлов`,
      );

      return {
        totalFiles: status.totalFiles,
        lastIndexed: status.lastIndexed?.toISOString() || null,
        languages: status.languages,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при получении статуса индекса проекта ${projectId} (${duration}ms):`,
        error,
      );
      throw error;
    }
  }

  private mapReportToDto(report: AnalysisReport): AnalysisReportDto {
    return {
      id: report.id,
      projectId: report.projectId,
      type: report.type as AnalysisType,
      status: report.status,
      filePath: report.filePath,
      language: report.language,
      result: (report.result as AnalysisResultDto) || {},
      error: report.error || undefined,
      progress: report.progress || undefined,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  private mapVulnerabilityToDto(
    vuln: VulnerabilityResult['vulnerabilities'][0],
  ): VulnerabilityDto {
    return {
      id: vuln.id,
      severity: vuln.severity as VulnSeverity,
      type: vuln.type,
      title: vuln.title,
      description: vuln.description,
      filePath: vuln.filePath,
      lineStart: vuln.lineStart,
      lineEnd: vuln.lineEnd,
      codeSnippet: vuln.codeSnippet,
      recommendation: vuln.recommendation,
      cwe: vuln.cwe || undefined,
      createdAt: vuln.createdAt,
    };
  }

  private mapRecommendationToDto(
    recommendation: import('./recommendations/recommendations.service').Recommendation,
  ): RecommendationDto {
    return {
      id: recommendation.id,
      title: recommendation.title,
      description: recommendation.description,
      category: recommendation.category.toLowerCase(),
      priority: recommendation.priority,
      impact: recommendation.impact,
      suggestion: recommendation.suggestion,
      filePath: recommendation.filePath,
      lineStart: recommendation.lineStart || undefined,
      lineEnd: recommendation.lineEnd || undefined,
      codeSnippet: recommendation.codeSnippet || undefined,
      createdAt: new Date().toISOString(), // Используем текущую дату, так как в Recommendation нет createdAt
    };
  }

  private calculateEstimatedTime(report: AnalysisReport): number | undefined {
    if (
      report.status === AnalysisStatus.COMPLETED ||
      report.status === AnalysisStatus.FAILED
    ) {
      return undefined;
    }

    // Простая оценка времени на основе типа анализа
    const baseTime: Record<string, number> = {
      VULNERABILITY: 120, // 2 минуты
      EXPLANATION: 300, // 5 минут
      RECOMMENDATION: 60, // 1 минута
      FULL: 600, // 10 минут
    };

    const estimatedTotal = baseTime[report.type] || 300;
    const progress = report.progress?.percentage || 0;
    const remaining = Math.max(
      0,
      estimatedTotal - (estimatedTotal * progress) / 100,
    );

    return Math.round(remaining);
  }
}
