import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ProjectsService } from '../projects/projects.service';
import { VulnerabilityService } from './vulnerability/vulnerability.service';
import { ExplanationService } from './explanation/explanation.service';
import { RecommendationsService } from './recommendations/recommendations.service';
import { AnalysisStatus } from './dto/analysis-response.dto';
import { AnalysisType } from './dto/analysis-request.dto';
import type { AnalysisReport } from '../../generated/prisma';
import { AnalysisStatus as DbAnalysisStatus } from '../../generated/prisma';
import type { ExplanationOptions } from './explanation/explanation.service';
import type { VulnerabilityScanOptions } from './vulnerability/vulnerability.service';
import type { Recommendation } from './recommendations/recommendations.service';
import { isDevelopment, getLogLevel, AnalysisCancellationError } from './utils/environment.util';

export interface FullAnalysisOptions {
  includeTests?: boolean;
  languages?: string[];
  includeComplexity?: boolean;
  maxSymbols?: number;
}

type RecommendationOptions = { languages?: string[] };
type AnalysisOptions =
  | FullAnalysisOptions
  | VulnerabilityScanOptions
  | ExplanationOptions
  | RecommendationOptions;

interface VulnerabilitySummaryLike {
  vulnerabilitiesFound?: number;
}

interface ExplanationsSummaryLike {
  symbolsExplained?: number;
  totalSymbols?: number;
}

interface RecommendationsSummary {
  items: Recommendation[];
  total: number;
  byPriority: Record<string, number>;
}

interface FullAnalysisResults {
  vulnerabilities?: VulnerabilitySummaryLike;
  explanations?: ExplanationsSummaryLike;
  recommendations?: RecommendationsSummary;
}

interface AnalysisStatsSummary {
  totalAnalyses: number;
  completedAnalyses: number;
  failedAnalyses: number;
  averageDuration: number;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly projectsService: ProjectsService,
    private readonly vulnerabilityService: VulnerabilityService,
    private readonly explanationService: ExplanationService,
    private readonly recommendationsService: RecommendationsService,
  ) {}

  async startAnalysis(
    userId: string,
    projectId: string,
    type: AnalysisType,
    options?: AnalysisOptions,
    query?: string,
  ): Promise<AnalysisReport> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем анализ проекта ${projectId} (тип: ${type}) для пользователя ${userId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры анализа:', {
        userId,
        projectId,
        type,
        options,
      });
    }

    await this.projectsService.findByIdForUser(userId, projectId);

    // Очищаем старые данные анализа того же типа для этого проекта
    await this.cleanupOldAnalysisData(projectId, type, null);

    const report = await this.databaseService.analysisReport.create({
      data: {
        projectId,
        type,
        status: AnalysisStatus.PENDING,
        language: options?.languages?.join(',') || 'all',
        result: {},
        progress: {
          currentStep: 'Initializing analysis',
          percentage: 0,
          processedFiles: 0,
          totalFiles: 0,
        },
      },
    });

    this.logger.log(`Создан отчет анализа ${report.id} для проекта ${projectId}`);

    // Запускаем анализ в фоне
    void this.performAnalysis(report.id, userId, projectId, type, options, query);

    const duration = Date.now() - startTime;
    this.logger.log(`Анализ ${report.id} инициализирован за ${duration}ms`);

    return report;
  }

  async getAnalysisStatus(reportId: string): Promise<AnalysisReport> {
    const report = await this.databaseService.analysisReport.findUnique({
      where: { id: reportId },
      include: {
        vulnerabilities: true,
        explanations: true,
      },
    });

    if (!report) {
      throw new Error('Отчет анализа не найден');
    }

    return report;
  }

  async cancelAnalysis(reportId: string): Promise<boolean> {
    const report = await this.databaseService.analysisReport.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      return false;
    }

    if (
      report.status === DbAnalysisStatus.COMPLETED ||
      report.status === DbAnalysisStatus.FAILED
    ) {
      return false;
    }

    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        status: AnalysisStatus.CANCELLED,
        progress: {
          currentStep: 'Cancelled',
          percentage: 0,
          processedFiles: 0,
          totalFiles: 0,
        },
      },
    });

    return true;
  }

  async getProjectAnalysisHistory(
    userId: string,
    projectId: string,
    filters: {
      type?: AnalysisType;
      status?: AnalysisStatus;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{
    reports: AnalysisReport[];
    total: number;
    stats: AnalysisStatsSummary;
  }> {
    await this.projectsService.findByIdForUser(userId, projectId);

    const where: Record<string, unknown> = { projectId };

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    const [reports, total] = await Promise.all([
      this.databaseService.analysisReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: filters.limit || 20,
        skip: filters.offset || 0,
        include: {
          vulnerabilities: true,
          explanations: true,
        },
      }),
      this.databaseService.analysisReport.count({ where }),
    ]);

    const stats = await this.calculateAnalysisStats(projectId);

    return { reports, total, stats };
  }

  private async performAnalysis(
    reportId: string,
    userId: string,
    projectId: string,
    type: AnalysisType,
    options: AnalysisOptions | undefined,
    query?: string,
  ): Promise<void> {
    const logLevel = getLogLevel();
    const analysisStartTime = Date.now();

    this.logger.log(`Начинаем выполнение анализа ${reportId} (тип: ${type})`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры выполнения анализа:', {
        reportId,
        userId,
        projectId,
        type,
        options,
      });
    }

    try {
      // Проверяем отмену перед началом
      await this.checkCancellation(reportId);

      await this.updateReportStatus(
        reportId,
        AnalysisStatus.PROCESSING,
        'Starting analysis',
        0,
      );

      const stepStartTime = Date.now();

      switch (type) {
        case AnalysisType.VULNERABILITY:
          this.logger.log(`Выполняем анализ уязвимостей для отчета ${reportId}`);
          await this.performVulnerabilityAnalysis(
            reportId,
            userId,
            projectId,
            this.toVulnerabilityOptions(options),
          );
          break;
        case AnalysisType.EXPLANATION:
          this.logger.log(`Выполняем анализ объяснений для отчета ${reportId}`);
          await this.performExplanationAnalysis(
            reportId,
            userId,
            projectId,
            this.toExplanationOptions(options, query),
          );
          break;
        case AnalysisType.RECOMMENDATION:
          this.logger.log(`Выполняем анализ рекомендаций для отчета ${reportId}`);
          await this.performRecommendationAnalysis(
            reportId,
            userId,
            projectId,
            this.toRecommendationOptions(options),
          );
          break;
        case AnalysisType.FULL:
          this.logger.log(`Выполняем полный анализ для отчета ${reportId}`);
          await this.performFullAnalysis(
            reportId,
            userId,
            projectId,
            this.toFullOptions(options),
            query,
          );
          break;
        default:
          // Если добавлен новый тип и не обработан выше, бросаем ошибку
          throw new Error('Неподдерживаемый тип анализа');
      }

      // Проверяем отмену после завершения
      await this.checkCancellation(reportId);

      const stepDuration = Date.now() - stepStartTime;
      this.logger.log(`Анализ ${type} для отчета ${reportId} выполнен за ${stepDuration}ms`);

      await this.updateReportStatus(
        reportId,
        AnalysisStatus.COMPLETED,
        'Analysis completed',
        100,
      );

      const totalDuration = Date.now() - analysisStartTime;
      this.logger.log(`Анализ ${reportId} успешно завершен за ${totalDuration}ms`);

    } catch (error) {
      const totalDuration = Date.now() - analysisStartTime;
      
      // Если это ошибка отмены, не логируем как ошибку
      if (error instanceof AnalysisCancellationError) {
        this.logger.log(`Анализ ${reportId} был отменен пользователем (${totalDuration}ms)`);
        return; // Не обновляем статус, он уже установлен в CANCELLED
      }

      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      
      this.logger.error(
        `Ошибка при выполнении анализа ${reportId} (${totalDuration}ms): ${message}`,
      );

      if (logLevel === 'detailed') {
        this.logger.debug('Детали ошибки:', {
          reportId,
          type,
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          } : String(error),
        });
      }

      await this.updateReportStatus(
        reportId,
        AnalysisStatus.FAILED,
        'Analysis failed',
        0,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  private async performVulnerabilityAnalysis(
    reportId: string,
    userId: string,
    projectId: string,
    options: VulnerabilityScanOptions,
  ): Promise<void> {
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Scanning for vulnerabilities',
      10,
    );

    // Запускаем сканирование напрямую для существующего отчета
    await this.vulnerabilityService.scanProjectForReport(
      reportId,
      userId,
      projectId,
      options,
    );
  }

  private async performExplanationAnalysis(
    reportId: string,
    userId: string,
    projectId: string,
    options: ExplanationOptions,
  ): Promise<void> {
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Generating code explanations',
      10,
    );

    // Запускаем объяснение напрямую для существующего отчета
    await this.explanationService.explainProjectForReport(
      reportId,
      userId,
      projectId,
      options,
    );
  }

  private async performRecommendationAnalysis(
    reportId: string,
    userId: string,
    projectId: string,
    options: RecommendationOptions,
  ): Promise<void> {
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Analyzing code quality',
      10,
    );

    const recommendations = await this.recommendationsService.analyzeProject(
      userId,
      projectId,
      options,
    );

    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        result: {
          recommendations: recommendations,
          totalRecommendations: recommendations.length,
          byPriority: this.groupRecommendationsByPriority(recommendations),
        } as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
        progress: {
          currentStep: 'Completed',
          percentage: 100,
          processedFiles: 1,
          totalFiles: 1,
        } as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
      },
    });
  }

  private async performFullAnalysis(
    reportId: string,
    userId: string,
    projectId: string,
    options: FullAnalysisOptions,
    query?: string,
  ): Promise<void> {
    const logLevel = getLogLevel();
    const fullAnalysisStartTime = Date.now();

    this.logger.log(`Начинаем полный анализ для отчета ${reportId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры полного анализа:', {
        reportId,
        userId,
        projectId,
        options,
      });
    }

    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Starting full analysis',
      5,
    );

    // Выполняем все типы анализа последовательно
    const results: FullAnalysisResults = {};

    // 1. Анализ уязвимостей (30% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Scanning vulnerabilities',
      10,
    );
    
    const vulnStartTime = Date.now();
    this.logger.log(`Выполняем анализ уязвимостей для полного анализа ${reportId}`);
    
    await this.vulnerabilityService.scanProjectForReport(
      reportId,
      userId,
      projectId,
      this.toVulnerabilityOptions(options),
    );

    // Получаем результаты сканирования уязвимостей
    const vulnReport = await this.databaseService.analysisReport.findUnique({
      where: { id: reportId },
    });

    if (vulnReport?.result) {
      results.vulnerabilities = vulnReport.result as VulnerabilitySummaryLike;
    }
    
    const vulnDuration = Date.now() - vulnStartTime;
    this.logger.log(`Анализ уязвимостей для отчета ${reportId} завершен за ${vulnDuration}ms`);

    // 2. Объяснение кода (60% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Generating explanations',
      40,
    );
    
    const explanationStartTime = Date.now();
    this.logger.log(`Выполняем анализ объяснений для полного анализа ${reportId}`);
    
    await this.explanationService.explainProjectForReport(
      reportId,
      userId,
      projectId,
      this.toExplanationOptions(options, query),
    );

    // Получаем результаты объяснения
    const explanationReport = await this.databaseService.analysisReport.findUnique({
      where: { id: reportId },
    });

    if (explanationReport?.result) {
      results.explanations = explanationReport.result as ExplanationsSummaryLike;
    }
    
    const explanationDuration = Date.now() - explanationStartTime;
    this.logger.log(`Анализ объяснений для отчета ${reportId} завершен за ${explanationDuration}ms`);

    // 3. Рекомендации (90% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Analyzing recommendations',
      70,
    );
    
    const recommendationsStartTime = Date.now();
    this.logger.log(`Выполняем анализ рекомендаций для полного анализа ${reportId}`);
    
    const recommendations = await this.recommendationsService.analyzeProject(
      userId,
      projectId,
      this.toRecommendationOptions(options),
    );
    results.recommendations = {
      items: recommendations,
      total: recommendations.length,
      byPriority: this.groupRecommendationsByPriority(recommendations),
    };
    
    const recommendationsDuration = Date.now() - recommendationsStartTime;
    this.logger.log(`Анализ рекомендаций для отчета ${reportId} завершен за ${recommendationsDuration}ms`);

    // 4. Финальные результаты (100% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Finalizing results',
      90,
    );

    const summary = this.generateAnalysisSummary(results);
    
    if (logLevel === 'detailed') {
      this.logger.debug('Результаты полного анализа:', {
        reportId,
        vulnerabilities: results.vulnerabilities,
        explanations: results.explanations,
        recommendations: results.recommendations,
        summary,
      });
    } else {
      this.logger.log(`Полный анализ ${reportId}: найдено ${summary.vulnerabilitiesFound} уязвимостей, ${summary.explanationsGenerated} объяснений, ${summary.recommendationsCount} рекомендаций`);
    }

    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        result: {
          ...results,
          summary,
        } as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
        progress: {
          currentStep: 'Completed',
          percentage: 100,
          processedFiles: 1,
          totalFiles: 1,
        } as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
      },
    });

    const totalDuration = Date.now() - fullAnalysisStartTime;
    this.logger.log(`Полный анализ ${reportId} завершен за ${totalDuration}ms`);
  }

  private async updateReportStatus(
    reportId: string,
    status: AnalysisStatus,
    currentStep: string,
    percentage: number,
    error?: string,
  ): Promise<void> {
    try {
      // Проверяем существование отчета перед обновлением
      const existingReport = await this.databaseService.analysisReport.findUnique({
        where: { id: reportId },
        select: { id: true },
      });

      if (!existingReport) {
        this.logger.warn(`Попытка обновить несуществующий отчет ${reportId}`);
        return;
      }

      await this.databaseService.analysisReport.update({
        where: { id: reportId },
        data: {
          status,
          progress: {
            currentStep,
            percentage,
            processedFiles: 0,
            totalFiles: 0,
          },
          ...(error && { error }),
        },
      });
    } catch (error) {
      this.logger.error(`Ошибка при обновлении статуса отчета ${reportId}:`, error);
      // Не прерываем выполнение анализа из-за ошибки обновления статуса
    }
  }

  private async checkCancellation(reportId: string): Promise<void> {
    const report = await this.databaseService.analysisReport.findUnique({
      where: { id: reportId },
      select: { status: true },
    });

    if (report?.status === 'CANCELLED') {
      throw new AnalysisCancellationError(reportId);
    }
  }

  private async cleanupOldAnalysisData(projectId: string, analysisType: AnalysisType, excludeReportId?: string | null): Promise<void> {
    const logLevel = getLogLevel();
    const cleanupStartTime = Date.now();

    this.logger.log(`Очищаем старые данные анализа типа ${analysisType} для проекта ${projectId}${excludeReportId ? ` (исключая отчет ${excludeReportId})` : ''}`);

    try {
      // Получаем все старые отчеты анализа того же типа для проекта
      const whereClause: any = { 
        projectId,
        type: analysisType
      };
      if (excludeReportId) {
        whereClause.id = { not: excludeReportId };
      }

      const oldReports = await this.databaseService.analysisReport.findMany({
        where: whereClause,
        select: { id: true },
      });

      if (oldReports.length === 0) {
        this.logger.log(`Нет старых данных анализа типа ${analysisType} для очистки в проекте ${projectId}`);
        return;
      }

      const reportIds = oldReports.map(report => report.id);

      if (logLevel === 'detailed') {
        this.logger.debug('Очищаем данные для отчетов:', {
          projectId,
          analysisType,
          reportIds,
          count: reportIds.length,
        });
      }

      // Удаляем связанные данные в правильном порядке (из-за foreign key constraints)
      
      // 1. Удаляем уязвимости
      const deletedVulnerabilities = await this.databaseService.vulnerability.deleteMany({
        where: { reportId: { in: reportIds } },
      });

      // 2. Удаляем объяснения кода
      const deletedExplanations = await this.databaseService.codeExplanation.deleteMany({
        where: { reportId: { in: reportIds } },
      });

      // 3. Удаляем отчеты анализа
      const deletedReports = await this.databaseService.analysisReport.deleteMany({
        where: { id: { in: reportIds } },
      });

      const cleanupDuration = Date.now() - cleanupStartTime;
      this.logger.log(`Очистка данных анализа типа ${analysisType} для проекта ${projectId} завершена за ${cleanupDuration}ms: удалено ${deletedReports.count} отчетов, ${deletedVulnerabilities.count} уязвимостей, ${deletedExplanations.count} объяснений`);

      if (logLevel === 'detailed') {
        this.logger.debug('Статистика очистки:', {
          projectId,
          analysisType,
          deletedReports: deletedReports.count,
          deletedVulnerabilities: deletedVulnerabilities.count,
          deletedExplanations: deletedExplanations.count,
          cleanupDuration,
        });
      }

    } catch (error) {
      const cleanupDuration = Date.now() - cleanupStartTime;
      this.logger.error(`Ошибка при очистке старых данных анализа для проекта ${projectId} (${cleanupDuration}ms):`, error);
      
      if (logLevel === 'detailed') {
        this.logger.debug('Детали ошибки очистки:', {
          projectId,
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          } : String(error),
        });
      }
      
      // Не прерываем выполнение анализа из-за ошибки очистки
      this.logger.warn(`Продолжаем анализ несмотря на ошибку очистки данных для проекта ${projectId}`);
    }
  }

  private groupRecommendationsByPriority(
    recommendations: Recommendation[],
  ): Record<string, number> {
    const initial: Record<string, number> = {};
    return recommendations.reduce((acc, rec) => {
      acc[rec.priority] = (acc[rec.priority] || 0) + 1;
      return acc;
    }, initial);
  }

  private generateAnalysisSummary(results: FullAnalysisResults): {
    vulnerabilitiesFound: number;
    explanationsGenerated: number;
    recommendationsCount: number;
    analysisDate: string;
  } {
    const explanationsGenerated =
      results.explanations?.symbolsExplained ??
      results.explanations?.totalSymbols ??
      0;

    return {
      vulnerabilitiesFound: results.vulnerabilities?.vulnerabilitiesFound ?? 0,
      explanationsGenerated,
      recommendationsCount: results.recommendations?.total ?? 0,
      analysisDate: new Date().toISOString(),
    };
  }

  private async calculateAnalysisStats(
    projectId: string,
  ): Promise<AnalysisStatsSummary> {
    const [total, completed, failed] = await Promise.all([
      this.databaseService.analysisReport.count({ where: { projectId } }),
      this.databaseService.analysisReport.count({
        where: { projectId, status: 'COMPLETED' },
      }),
      this.databaseService.analysisReport.count({
        where: { projectId, status: 'FAILED' },
      }),
    ]);

    // Вычисляем среднее время выполнения
    const completedReports = await this.databaseService.analysisReport.findMany(
      {
        where: { projectId, status: 'COMPLETED' },
        select: { createdAt: true, updatedAt: true },
      },
    );

    const averageDuration =
      completedReports.length > 0
        ? completedReports.reduce((sum, report) => {
            const duration =
              report.updatedAt.getTime() - report.createdAt.getTime();
            return sum + duration;
          }, 0) /
          completedReports.length /
          1000 // в секундах
        : 0;

    return {
      totalAnalyses: total,
      completedAnalyses: completed,
      failedAnalyses: failed,
      averageDuration: Math.round(averageDuration),
    };
  }

  private toVulnerabilityOptions(
    options: AnalysisOptions | undefined,
  ): VulnerabilityScanOptions {
    const o = (options || {}) as Partial<
      VulnerabilityScanOptions & FullAnalysisOptions
    >;
    return {
      includeTests: o.includeTests,
      maxFileSize: o.maxFileSize,
      excludePatterns: o.excludePatterns,
      languages: o.languages,
      severityThreshold: o.severityThreshold,
    };
  }

  private toExplanationOptions(
    options: AnalysisOptions | undefined,
    query?: string,
  ): ExplanationOptions {
    const o = (options || {}) as Partial<
      ExplanationOptions & FullAnalysisOptions
    >;
    return {
      includeComplexity: o.includeComplexity,
      maxSymbols: o.maxSymbols,
      languages: o.languages,
      query,
    };
  }

  private toRecommendationOptions(
    options: AnalysisOptions | undefined,
  ): RecommendationOptions {
    const o = (options || {}) as Partial<RecommendationOptions>;
    return { languages: o.languages };
  }

  private toFullOptions(
    options: AnalysisOptions | undefined,
  ): FullAnalysisOptions {
    const o = (options || {}) as Partial<FullAnalysisOptions>;
    return {
      includeTests: o.includeTests,
      languages: o.languages,
      includeComplexity: o.includeComplexity,
      maxSymbols: o.maxSymbols,
    };
  }
}
