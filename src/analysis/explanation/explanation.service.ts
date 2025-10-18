import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { OpenAIService } from './openai.service';
import { AstParserService, ParsedFile } from './ast-parser.service';
import type {
  AnalysisReport,
  CodeExplanation,
} from '../../../generated/prisma';

export interface ExplanationOptions {
  includeComplexity?: boolean;
  maxSymbols?: number;
  languages?: string[];
}

@Injectable()
export class ExplanationService {
  private readonly logger = new Logger(ExplanationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly projectsService: ProjectsService,
    private readonly openaiService: OpenAIService,
    private readonly astParserService: AstParserService,
  ) {}

  async explainProject(
    userId: string,
    projectId: string,
    options: ExplanationOptions = {},
  ): Promise<AnalysisReport> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );

    const report = await this.databaseService.analysisReport.create({
      data: {
        projectId,
        type: 'EXPLANATION',
        status: 'PROCESSING',
        language: options.languages?.join(',') || 'all',
        result: {},
        progress: {
          currentStep: 'Starting code analysis',
          percentage: 0,
          processedFiles: 0,
          totalFiles: 0,
        },
      },
    });

    try {
      // Запускаем анализ в фоне
      void this.performExplanation(report.id, project.extractedPath, options);

      return report;
    } catch (error) {
      await this.databaseService.analysisReport.update({
        where: { id: report.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async explainFile(
    userId: string,
    projectId: string,
    filePath: string,
    options: ExplanationOptions = {},
  ): Promise<AnalysisReport> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );

    const report = await this.databaseService.analysisReport.create({
      data: {
        projectId,
        type: 'EXPLANATION',
        status: 'PROCESSING',
        filePath,
        language: this.detectLanguageFromPath(filePath),
        result: {},
        progress: {
          currentStep: 'Analyzing file',
          percentage: 0,
          processedFiles: 0,
          totalFiles: 1,
        },
      },
    });

    try {
      const fullPath = `${project.extractedPath}/${filePath}`;
      const parsedFile = await this.astParserService.parseFile(fullPath);

      await this.explainSymbols(report.id, parsedFile, options);

      await this.databaseService.analysisReport.update({
        where: { id: report.id },
        data: {
          status: 'COMPLETED',
          result: {
            symbolsExplained: parsedFile.symbols.length,
            language: parsedFile.language,
          },
          progress: {
            currentStep: 'Completed',
            percentage: 100,
            processedFiles: 1,
            totalFiles: 1,
          },
        },
      });

      return report;
    } catch (error) {
      await this.databaseService.analysisReport.update({
        where: { id: report.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
      throw error;
    }
  }

  async explainSymbol(
    userId: string,
    projectId: string,
    filePath: string,
    symbolName: string,
    options: ExplanationOptions = {},
  ): Promise<CodeExplanation> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    const fullPath = `${project.extractedPath}/${filePath}`;

    const parsedFile = await this.astParserService.parseFile(fullPath);
    const symbol = parsedFile.symbols.find((s) => s.name === symbolName);

    if (!symbol) {
      throw new Error(`Символ ${symbolName} не найден в файле ${filePath}`);
    }

    const explanation = await this.openaiService.explainCode({
      symbol,
      includeComplexity: options.includeComplexity,
    });

    const savedExplanation = await this.databaseService.codeExplanation.create({
      data: {
        reportId: '', // Временный ID, в реальности нужно создать отчет
        filePath,
        symbolName: symbol.name,
        symbolType: symbol.type,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        summary: explanation.summary,
        detailed: explanation.detailed,
        complexity: explanation.complexity,
      },
    });

    return savedExplanation;
  }

  async getExplanations(
    userId: string,
    projectId: string,
    filters: {
      filePath?: string;
      symbolType?: string;
      symbolName?: string;
    } = {},
  ): Promise<CodeExplanation[]> {
    await this.projectsService.findByIdForUser(userId, projectId);

    const where: Record<string, any> = {
      report: {
        projectId,
        type: 'EXPLANATION',
      },
    };

    if (filters.filePath) {
      where.filePath = { contains: filters.filePath };
    }

    if (filters.symbolType) {
      where.symbolType = filters.symbolType;
    }

    if (filters.symbolName) {
      where.symbolName = { contains: filters.symbolName };
    }

    return this.databaseService.codeExplanation.findMany({
      where,
      orderBy: [{ filePath: 'asc' }, { lineStart: 'asc' }],
    });
  }

  private async performExplanation(
    reportId: string,
    projectPath: string,
    options: ExplanationOptions,
  ): Promise<void> {
    try {
      const languages = options.languages || [
        'typescript',
        'javascript',
        'python',
      ];
      const parsedFiles = await this.astParserService.parseProject(
        projectPath,
        languages,
      );

      let processedFiles = 0;
      const totalFiles = parsedFiles.length;

      await this.updateProgress(
        reportId,
        'Analyzing code structure',
        0,
        processedFiles,
        totalFiles,
      );

      for (const parsedFile of parsedFiles) {
        await this.explainSymbols(reportId, parsedFile, options);
        processedFiles++;

        const percentage = Math.round((processedFiles / totalFiles) * 100);
        await this.updateProgress(
          reportId,
          `Explaining ${parsedFile.filePath}`,
          percentage,
          processedFiles,
          totalFiles,
        );
      }

      await this.databaseService.analysisReport.update({
        where: { id: reportId },
        data: {
          status: 'COMPLETED',
          result: {
            filesAnalyzed: parsedFiles.length,
            totalSymbols: parsedFiles.reduce(
              (sum, f) => sum + f.symbols.length,
              0,
            ),
            languages: [...new Set(parsedFiles.map((f) => f.language))],
          },
          progress: {
            currentStep: 'Completed',
            percentage: 100,
            processedFiles,
            totalFiles,
          },
        },
      });
    } catch (error) {
      this.logger.error(`Ошибка при объяснении кода ${reportId}:`, error);
      await this.databaseService.analysisReport.update({
        where: { id: reportId },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  private async explainSymbols(
    reportId: string,
    parsedFile: ParsedFile,
    options: ExplanationOptions,
  ): Promise<void> {
    if (!this.openaiService.isAvailable()) {
      this.logger.warn('OpenAI API недоступен, пропускаем объяснение символов');
      return;
    }

    const symbols = parsedFile.symbols.slice(0, options.maxSymbols || 50);

    if (symbols.length === 0) {
      return;
    }

    try {
      // Объясняем символы пакетами для оптимизации
      const batchSize = 5;
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const explanations =
          await this.openaiService.explainMultipleSymbols(batch);

        const explanationsToSave = explanations.map((explanation, index) => ({
          reportId,
          filePath: parsedFile.filePath,
          symbolName: batch[index].name,
          symbolType: batch[index].type,
          lineStart: batch[index].lineStart,
          lineEnd: batch[index].lineEnd,
          summary: explanation.summary,
          detailed: explanation.detailed,
          complexity: explanation.complexity,
        }));

        await this.databaseService.codeExplanation.createMany({
          data: explanationsToSave,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось объяснить символы в файле ${parsedFile.filePath}:`,
        error,
      );
    }
  }

  private async updateProgress(
    reportId: string,
    currentStep: string,
    percentage: number,
    processedFiles: number,
    totalFiles: number,
  ): Promise<void> {
    await this.databaseService.analysisReport.update({
      where: { id: reportId },
      data: {
        progress: {
          currentStep,
          percentage,
          processedFiles,
          totalFiles,
        },
      },
    });
  }

  private detectLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'py':
        return 'python';
      case 'java':
        return 'java';
      case 'go':
        return 'go';
      default:
        return 'unknown';
    }
  }
}
