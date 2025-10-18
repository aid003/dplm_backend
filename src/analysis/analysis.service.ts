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
  ): Promise<AnalysisReport> {
    await this.projectsService.findByIdForUser(userId, projectId);

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

    // Запускаем анализ в фоне
    void this.performAnalysis(report.id, userId, projectId, type, options);

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
  ): Promise<void> {
    try {
      await this.updateReportStatus(
        reportId,
        AnalysisStatus.PROCESSING,
        'Starting analysis',
        0,
      );

      switch (type) {
        case AnalysisType.VULNERABILITY:
          await this.performVulnerabilityAnalysis(
            reportId,
            userId,
            projectId,
            this.toVulnerabilityOptions(options),
          );
          break;
        case AnalysisType.EXPLANATION:
          await this.performExplanationAnalysis(
            reportId,
            userId,
            projectId,
            this.toExplanationOptions(options),
          );
          break;
        case AnalysisType.RECOMMENDATION:
          await this.performRecommendationAnalysis(
            reportId,
            userId,
            projectId,
            this.toRecommendationOptions(options),
          );
          break;
        case AnalysisType.FULL:
          await this.performFullAnalysis(
            reportId,
            userId,
            projectId,
            this.toFullOptions(options),
          );
          break;
        default:
          // Если добавлен новый тип и не обработан выше, бросаем ошибку
          throw new Error('Неподдерживаемый тип анализа');
      }

      await this.updateReportStatus(
        reportId,
        AnalysisStatus.COMPLETED,
        'Analysis completed',
        100,
      );
    } catch (error) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(
        `Ошибка при выполнении анализа ${reportId}: ${message}`,
      );
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

    const report = await this.vulnerabilityService.scanProject(
      userId,
      projectId,
      options,
    );

    // Обновляем основной отчет результатами сканирования уязвимостей
    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        result:
          report.result as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
        progress:
          report.progress as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
      },
    });
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

    const report = await this.explanationService.explainProject(
      userId,
      projectId,
      options,
    );

    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        result:
          report.result as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
        progress:
          report.progress as unknown as import('../../generated/prisma').Prisma.InputJsonValue,
      },
    });
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
  ): Promise<void> {
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
    const vulnReport = await this.vulnerabilityService.scanProject(
      userId,
      projectId,
      this.toVulnerabilityOptions(options),
    );
    results.vulnerabilities = vulnReport.result as VulnerabilitySummaryLike;

    // 2. Объяснение кода (60% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Generating explanations',
      40,
    );
    const explanationReport = await this.explanationService.explainProject(
      userId,
      projectId,
      this.toExplanationOptions(options),
    );
    results.explanations = explanationReport.result as ExplanationsSummaryLike;

    // 3. Рекомендации (90% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Analyzing recommendations',
      70,
    );
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

    // 4. Финальные результаты (100% прогресса)
    await this.updateReportStatus(
      reportId,
      AnalysisStatus.PROCESSING,
      'Finalizing results',
      90,
    );

    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        result: {
          ...results,
          summary: this.generateAnalysisSummary(results),
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

  private async updateReportStatus(
    reportId: string,
    status: AnalysisStatus,
    currentStep: string,
    percentage: number,
    error?: string,
  ): Promise<void> {
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
  ): ExplanationOptions {
    const o = (options || {}) as Partial<
      ExplanationOptions & FullAnalysisOptions
    >;
    return {
      includeComplexity: o.includeComplexity,
      maxSymbols: o.maxSymbols,
      languages: o.languages,
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
