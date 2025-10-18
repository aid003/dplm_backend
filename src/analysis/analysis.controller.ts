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
import { AnalysisRequestDto, AnalysisType } from './dto/analysis-request.dto';
import {
  AnalysisReportDto,
  AnalysisStatusDto,
  AnalysisHistoryDto,
  VulnerabilityDto,
  CodeExplanationDto,
  AnalysisResultDto,
} from './dto/analysis-response.dto';
import { ExplainRequestDto } from './dto/explain-request.dto';
import {
  AnalysisStatus,
  AnalysisProgressDto,
  VulnSeverity,
} from './dto/analysis-response.dto';

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

interface ExplanationResult {
  id: string;
  filePath: string;
  symbolName: string | null;
  symbolType: string | null;
  lineStart: number;
  lineEnd: number;
  summary: string;
  detailed: string;
  complexity: number | null;
  createdAt: Date;
  reportId: string;
}

@ApiTags('analysis')
@Controller('analysis')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly vulnerabilityService: VulnerabilityService,
    private readonly explanationService: ExplanationService,
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
    const report = await this.analysisService.startAnalysis(
      req.user.id,
      projectId,
      body.type,
      body.options || {},
    );

    return {
      reportId: report.id,
      status: report.status,
    };
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
    const report = await this.analysisService.getAnalysisStatus(reportId);
    return this.mapReportToDto(report as unknown as AnalysisReport);
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
    const result = (await this.analysisService.getProjectAnalysisHistory(
      req.user.id,
      projectId,
      { type, status: status as AnalysisStatus | undefined, limit, offset },
    )) as AnalysisHistoryResult;

    return {
      reports: result.reports.map((report) => this.mapReportToDto(report)),
      total: result.total,
      stats: result.stats,
    };
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
    const explanation = await this.explanationService.explainSymbol(
      req.user.id,
      projectId,
      body.filePath,
      body.symbolName || '',
      { includeComplexity: true },
    );

    return this.mapExplanationToDto(explanation);
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
  async getExplanations(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Query('filePath') filePath?: string,
    @Query('symbolType') symbolType?: string,
    @Query('symbolName') symbolName?: string,
  ): Promise<CodeExplanationDto[]> {
    const explanations = await this.explanationService.getExplanations(
      req.user.id,
      projectId,
      { filePath, symbolType, symbolName },
    );

    return explanations.map((explanation) =>
      this.mapExplanationToDto(explanation),
    );
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

  private mapExplanationToDto(
    explanation: ExplanationResult,
  ): CodeExplanationDto {
    return {
      id: explanation.id,
      filePath: explanation.filePath,
      symbolName: explanation.symbolName || undefined,
      symbolType: explanation.symbolType || undefined,
      lineStart: explanation.lineStart,
      lineEnd: explanation.lineEnd,
      summary: explanation.summary,
      detailed: explanation.detailed,
      complexity: explanation.complexity || undefined,
      createdAt: explanation.createdAt,
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
