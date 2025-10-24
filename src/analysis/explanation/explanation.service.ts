import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { OpenAIService } from './openai.service';
import { AstParserService, ParsedFile } from './ast-parser.service';
import { SemanticSearchService } from './semantic-search.service';
import { DependencyAnalyzerService } from './dependency-analyzer.service';
import type {
  AnalysisReport,
  CodeExplanation,
} from '../../../generated/prisma';
import { isDevelopment, getLogLevel, AnalysisCancellationError } from '../utils/environment.util';

export interface ExplanationOptions {
  includeComplexity?: boolean;
  maxSymbols?: number;
  languages?: string[];
  query?: string;
}

@Injectable()
export class ExplanationService {
  private readonly logger = new Logger(ExplanationService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly projectsService: ProjectsService,
    private readonly openaiService: OpenAIService,
    private readonly astParserService: AstParserService,
    private readonly semanticSearchService: SemanticSearchService,
    private readonly dependencyAnalyzerService: DependencyAnalyzerService,
  ) {}

  async explainProject(
    userId: string,
    projectId: string,
    options: ExplanationOptions = {},
  ): Promise<AnalysisReport> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем объяснение проекта ${projectId} для пользователя ${userId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры объяснения проекта:', {
        userId,
        projectId,
        options,
      });
    }

    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );

    // Очищаем старые данные анализа объяснений для этого проекта
    await this.cleanupOldAnalysisData(projectId, 'EXPLANATION', null);

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

    this.logger.log(`Создан отчет объяснения ${report.id} для проекта ${projectId}`);

    try {
      // Запускаем анализ в фоне
      void this.performExplanation(report.id, project.extractedPath, options, userId);

      const duration = Date.now() - startTime;
      this.logger.log(`Объяснение проекта ${report.id} инициализировано за ${duration}ms`);

      return report;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Ошибка при инициализации объяснения проекта ${report.id} (${duration}ms):`, error);
      
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

  async explainProjectForReport(
    reportId: string,
    userId: string,
    projectId: string,
    options: ExplanationOptions = {},
  ): Promise<void> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем объяснение проекта для отчета ${reportId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры объяснения проекта для отчета:', {
        reportId,
        userId,
        projectId,
        options,
      });
    }

    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );

    try {
      // Запускаем объяснение напрямую для существующего отчета
      await this.performExplanation(reportId, project.extractedPath, options, userId);

      const duration = Date.now() - startTime;
      this.logger.log(`Объяснение проекта для отчета ${reportId} инициализировано за ${duration}ms`);

    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Ошибка при инициализации объяснения проекта для отчета ${reportId} (${duration}ms):`, error);
      
      await this.databaseService.analysisReport.update({
        where: { id: reportId },
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
  ): Promise<{ explanation: string }> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(
      `Генерируем связное объяснение для символа ${symbolName} в файле ${filePath}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры объяснения символа:', {
        userId,
        projectId,
        filePath,
        symbolName,
        options,
      });
    }

    try {
      this.logger.log(`1. Получаем проект для пользователя ${userId}, проекта ${projectId}`);
      const project = await this.projectsService.findByIdForUser(
        userId,
        projectId,
      );
      this.logger.log(`2. Проект получен: ${project.extractedPath}`);

      // Создаем вопрос пользователя на основе символа
      const userQuestion = `Объясни что делает символ "${symbolName}" в файле ${filePath} и как он работает`;
      this.logger.log(`3. Вопрос пользователя: ${userQuestion}`);

      // Получаем содержимое целевого файла
      const fullPath = `${project.extractedPath}/${filePath}`;
      this.logger.log(`4. Читаем файл: ${fullPath}`);
      const fileContent = await this.readFileContent(fullPath);
      const language = this.detectLanguageFromPath(filePath);
      this.logger.log(`5. Файл прочитан, размер: ${fileContent.length} символов, язык: ${language}`);

      // Ищем релевантные файлы с помощью семантического поиска
      this.logger.log(`6. Ищем релевантные файлы...`);
      const relevantFiles = await this.semanticSearchService.searchRelevantFiles(
        userId,
        projectId,
        userQuestion,
        5, // top-5 файлов
      );
      this.logger.log(`7. Найдено релевантных файлов: ${relevantFiles.length}`);

      // Собираем содержимое релевантных файлов
      const relevantFilesContent: Array<{ filePath: string; content: string; language: string }> = [];
      
      // Добавляем целевой файл первым
      relevantFilesContent.push({
        filePath,
        content: fileContent,
        language,
      });
      this.logger.log(`8. Добавлен целевой файл: ${filePath}`);

      // Добавляем релевантные файлы
      for (const relevantFile of relevantFiles) {
        try {
          const relevantFullPath = `${project.extractedPath}/${relevantFile.filePath}`;
          this.logger.log(`9. Читаем релевантный файл: ${relevantFullPath}`);
          const content = await this.readFileContent(relevantFullPath);
          const relevantLanguage = this.detectLanguageFromPath(relevantFile.filePath);
          
          relevantFilesContent.push({
            filePath: relevantFile.filePath,
            content,
            language: relevantLanguage,
          });
          this.logger.log(`10. Релевантный файл добавлен: ${relevantFile.filePath}`);
        } catch (error) {
          this.logger.warn(`Не удалось прочитать файл ${relevantFile.filePath}:`, error);
        }
      }

      this.logger.log(`11. Найдено ${relevantFilesContent.length} файлов для анализа`);

      // Генерируем связное объяснение
      this.logger.log(`12. Генерируем связное объяснение через OpenAI...`);
      const explanation = await this.openaiService.generateCohesiveExplanation({
        userQuestion,
        relevantFiles: relevantFilesContent,
        targetFilePath: filePath,
        targetSymbolName: symbolName,
      });
      this.logger.log(`13. Объяснение получено от OpenAI`);

      const duration = Date.now() - startTime;
      this.logger.log(
        `Связное объяснение для символа ${symbolName} сгенерировано за ${duration}ms`,
      );

      return { explanation: explanation.explanation };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при генерации связного объяснения для символа ${symbolName} (${duration}ms):`,
        error,
      );
      throw error;
    }
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
    userId?: string,
  ): Promise<void> {
    const logLevel = getLogLevel();
    const explanationStartTime = Date.now();

    this.logger.log(`Начинаем выполнение объяснения кода ${reportId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры объяснения:', {
        reportId,
        projectPath,
        options,
      });
    }

    try {
      const languages = options.languages || [
        'typescript',
        'javascript',
        'python',
        'go',
      ];

      let parsedFiles: ParsedFile[];

      // Проверяем, есть ли целевой запрос
      if (options.query) {
        this.logger.log(`Выполняем целевой анализ по запросу: "${options.query}"`);
        
        // Получаем отчет для доступа к projectId
        const report = await this.databaseService.analysisReport.findUnique({
          where: { id: reportId },
          select: { projectId: true },
        });

        if (!report) {
          throw new Error('Отчет анализа не найден');
        }

        // Ищем релевантные файлы
        if (!userId) {
          throw new Error('userId обязателен для целевого анализа');
        }
        
        const relevantFiles = await this.semanticSearchService.searchRelevantFiles(
          userId, // Передаем userId для проверки прав доступа
          report.projectId,
          options.query,
          10, // top-10 файлов
        );

        this.logger.log(`Найдено ${relevantFiles.length} релевантных файлов для запроса`);

        if (relevantFiles.length === 0) {
          this.logger.warn('Не найдено релевантных файлов, выполняем полный анализ');
          parsedFiles = await this.astParserService.parseProject(projectPath, languages);
        } else {
          // Получаем пути к файлам
          const filePaths = relevantFiles.map(f => f.filePath);
          
          // Анализируем зависимости
          const dependencies = await this.dependencyAnalyzerService.analyzeProjectDependencies(
            projectPath,
            filePaths,
            1, // глубина зависимостей
          );

          // Собираем все файлы для анализа (релевантные + их зависимости)
          const allFilePaths = new Set<string>();
          for (const [filePath, deps] of dependencies) {
            allFilePaths.add(filePath);
            deps.forEach(dep => allFilePaths.add(dep));
          }

          this.logger.log(`Анализируем ${allFilePaths.size} файлов (${filePaths.length} релевантных + ${allFilePaths.size - filePaths.length} зависимостей)`);

          // Парсим только найденные файлы
          parsedFiles = [];
          for (const filePath of allFilePaths) {
            try {
              const fullPath = `${projectPath}/${filePath}`;
              const parsedFile = await this.astParserService.parseFile(fullPath, filePath);
              parsedFiles.push(parsedFile);
            } catch (error) {
              this.logger.warn(`Не удалось распарсить файл ${filePath}:`, error);
            }
          }
        }
      } else {
        // Полный анализ как раньше
        this.logger.log(`Парсим проект для объяснения: языки ${languages.join(', ')}`);
        parsedFiles = await this.astParserService.parseProject(projectPath, languages);
      }

      const totalSymbols = parsedFiles.reduce((sum, f) => sum + f.symbols.length, 0);
      this.logger.log(`Найдено ${parsedFiles.length} файлов с ${totalSymbols} символами для объяснения`);

      if (logLevel === 'detailed') {
        this.logger.debug('Статистика парсинга:', {
          totalFiles: parsedFiles.length,
          totalSymbols,
          filesByLanguage: parsedFiles.reduce((acc, f) => {
            acc[f.language] = (acc[f.language] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          symbolsByFile: parsedFiles.map(f => ({
            filePath: f.filePath,
            language: f.language,
            symbolCount: f.symbols.length,
          })),
        });
      }

      let processedFiles = 0;
      const totalFiles = parsedFiles.length;
      let totalExplainedSymbols = 0;

      await this.updateProgress(
        reportId,
        'Analyzing code structure',
        0,
        processedFiles,
        totalFiles,
      );

      for (const parsedFile of parsedFiles) {
        const fileStartTime = Date.now();
        this.logger.log(`Объясняем символы в файле ${parsedFile.filePath} (${parsedFile.symbols.length} символов)`);

        const explainedCount = await this.explainSymbols(reportId, parsedFile, options);
        totalExplainedSymbols += explainedCount;
        processedFiles++;

        const fileDuration = Date.now() - fileStartTime;
        this.logger.log(`Файл ${parsedFile.filePath} обработан за ${fileDuration}ms: объяснено ${explainedCount} символов`);

        const percentage = Math.round((processedFiles / totalFiles) * 100);
        await this.updateProgress(
          reportId,
          `Explaining ${parsedFile.filePath}`,
          percentage,
          processedFiles,
          totalFiles,
        );
      }

      const result = {
        filesAnalyzed: parsedFiles.length,
        totalSymbols,
        explainedSymbols: totalExplainedSymbols,
        languages: [...new Set(parsedFiles.map((f) => f.language))],
        targetedAnalysis: !!options.query,
        query: options.query || undefined,
      };

      // Для targetedAnalysis генерируем связное объяснение
      if (options.query) {
        this.logger.log(`Генерируем связное объяснение для targetedAnalysis с запросом: "${options.query}"`);
        
        try {
          // Собираем содержимое всех проанализированных файлов
          const relevantFilesContent: Array<{ filePath: string; content: string; language: string }> = [];
          
          for (const parsedFile of parsedFiles) {
            try {
              // parsedFile.filePath уже содержит относительный путь
              const fullPath = `${projectPath}/${parsedFile.filePath}`;
              const content = await this.readFileContent(fullPath);
              const language = this.detectLanguageFromPath(parsedFile.filePath);
              
              relevantFilesContent.push({
                filePath: parsedFile.filePath,
                content,
                language,
              });
            } catch (error) {
              this.logger.warn(`Не удалось прочитать файл ${parsedFile.filePath} для связного объяснения:`, error);
            }
          }

          this.logger.log(`Собрано ${relevantFilesContent.length} файлов для связного объяснения`);

          // Генерируем связное объяснение
          const cohesiveExplanation = await this.openaiService.generateCohesiveExplanation({
            userQuestion: options.query,
            relevantFiles: relevantFilesContent,
            targetFilePath: '', // Для targetedAnalysis нет конкретного файла
            targetSymbolName: '', // Для targetedAnalysis нет конкретного символа
          });

          // Добавляем explanation в result
          (result as any).explanation = cohesiveExplanation.explanation;
          
          this.logger.log(`Связное объяснение сгенерировано и добавлено в result (${cohesiveExplanation.explanation.length} символов)`);
        } catch (error) {
          this.logger.error(`Ошибка при генерации связного объяснения для targetedAnalysis:`, error);
          // Не прерываем выполнение, просто не добавляем explanation
        }
      }

      this.logger.log(`Объяснение ${reportId} завершено: обработано ${result.filesAnalyzed} файлов, объяснено ${result.explainedSymbols} из ${result.totalSymbols} символов`);

      if (logLevel === 'detailed') {
        this.logger.debug('Результаты объяснения:', {
          reportId,
          ...result,
        });
      }

      await this.databaseService.analysisReport.update({
        where: { id: reportId },
        data: {
          status: 'COMPLETED',
          result,
          progress: {
            currentStep: 'Completed',
            percentage: 100,
            processedFiles,
            totalFiles,
          },
        },
      });

      const totalDuration = Date.now() - explanationStartTime;
      this.logger.log(`Объяснение кода ${reportId} успешно завершено за ${totalDuration}ms`);

    } catch (error) {
      const totalDuration = Date.now() - explanationStartTime;
      this.logger.error(`Ошибка при объяснении кода ${reportId} (${totalDuration}ms):`, error);
      
      if (logLevel === 'detailed') {
        this.logger.debug('Детали ошибки объяснения:', {
          reportId,
          projectPath,
          options,
          error: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          } : String(error),
        });
      }

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
  ): Promise<number> {
    const logLevel = getLogLevel();

    if (!this.openaiService.isAvailable()) {
      this.logger.warn('OpenAI API недоступен, пропускаем объяснение символов');
      return 0;
    }

    const symbols = parsedFile.symbols.slice(0, options.maxSymbols || 50);

    if (symbols.length === 0) {
      this.logger.log(`Нет символов для объяснения в файле ${parsedFile.filePath}`);
      return 0;
    }

    this.logger.log(`Объясняем ${symbols.length} символов в файле ${parsedFile.filePath}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Символы для объяснения:', {
        filePath: parsedFile.filePath,
        symbols: symbols.map(s => ({
          name: s.name,
          type: s.type,
          lineStart: s.lineStart,
          lineEnd: s.lineEnd,
        })),
      });
    }

    let explainedCount = 0;

    try {
      // Объясняем символы пакетами для оптимизации
      const batchSize = 5;
      for (let i = 0; i < symbols.length; i += batchSize) {
        // Проверяем отмену перед каждым пакетом
        await this.checkCancellation(reportId);

        const batch = symbols.slice(i, i + batchSize);
        const batchStartTime = Date.now();
        
        this.logger.log(`Обрабатываем пакет ${Math.floor(i / batchSize) + 1}/${Math.ceil(symbols.length / batchSize)} символов (${batch.length} символов)`);

        const explanations = await this.openaiService.explainMultipleSymbols(batch);
        const batchDuration = Date.now() - batchStartTime;

        this.logger.log(`Пакет символов обработан за ${batchDuration}ms`);

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

        explainedCount += explanations.length;

        if (logLevel === 'detailed') {
          this.logger.debug(`Сохранены объяснения для пакета:`, {
            filePath: parsedFile.filePath,
            batchSize: batch.length,
            explainedCount: explanations.length,
            batchDuration,
          });
        }
      }

      this.logger.log(`Успешно объяснено ${explainedCount} символов в файле ${parsedFile.filePath}`);
      return explainedCount;

    } catch (error) {
      if (error instanceof AnalysisCancellationError) {
        this.logger.log(`Объяснение символов в файле ${parsedFile.filePath} отменено`);
        throw error;
      }
      this.logger.warn(
        `Не удалось объяснить символы в файле ${parsedFile.filePath}:`,
        error,
      );
      return explainedCount;
    }
  }

  private async updateProgress(
    reportId: string,
    currentStep: string,
    percentage: number,
    processedFiles: number,
    totalFiles: number,
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
          progress: {
            currentStep,
            percentage,
            processedFiles,
            totalFiles,
          },
        },
      });
    } catch (error) {
      this.logger.error(`Ошибка при обновлении прогресса отчета ${reportId}:`, error);
      // Не прерываем выполнение анализа из-за ошибки обновления прогресса
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

  private async cleanupOldAnalysisData(projectId: string, analysisType: string, excludeReportId?: string | null): Promise<void> {
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

  private async readFileContent(filePath: string): Promise<string> {
    try {
      const fs = await import('fs/promises');
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.error(`Ошибка при чтении файла ${filePath}:`, error);
      throw new Error(`Не удалось прочитать файл ${filePath}`);
    }
  }
}
