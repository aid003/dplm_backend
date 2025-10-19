import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { AstParserService } from '../explanation/ast-parser.service';
import { isDevelopment, getLogLevel } from '../utils/environment.util';
import { AnalysisType } from '../dto/analysis-request.dto';
import { AnalysisStatus } from '../dto/analysis-response.dto';

export interface CodeSmell {
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
  recommendation: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  codeSnippet: string;
}

export interface Recommendation {
  id: string;
  category: 'PERFORMANCE' | 'MAINTAINABILITY' | 'SECURITY' | 'BEST_PRACTICES';
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  description: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  codeSnippet?: string;
  suggestion: string;
  impact: string;
}

interface CodeSymbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
  lineStart: number;
  lineEnd: number;
  code: string;
}

interface ParsedFile {
  filePath: string;
  symbols: CodeSymbol[];
  lines: string[];
}

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly projectsService: ProjectsService,
    private readonly astParserService: AstParserService,
  ) {}

  async analyzeProject(
    userId: string,
    projectId: string,
    options: { languages?: string[] } = {},
  ): Promise<Recommendation[]> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем анализ рекомендаций для проекта ${projectId} пользователя ${userId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры анализа рекомендаций:', {
        userId,
        projectId,
        options,
      });
    }

    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    const languages = options.languages || [
      'typescript',
      'javascript',
      'python',
      'go',
    ];

    this.logger.log(`Парсим проект для анализа рекомендаций: языки ${languages.join(', ')}`);

    const parsedFiles = await this.astParserService.parseProject(
      project.extractedPath,
      languages,
    );

    const totalSymbols = parsedFiles.reduce((sum, f) => sum + f.symbols.length, 0);
    this.logger.log(`Найдено ${parsedFiles.length} файлов с ${totalSymbols} символами для анализа рекомендаций`);

    if (logLevel === 'detailed') {
      this.logger.debug('Статистика парсинга для рекомендаций:', {
        totalFiles: parsedFiles.length,
        totalSymbols,
        filesByLanguage: parsedFiles.reduce((acc, f) => {
          acc[f.language] = (acc[f.language] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      });
    }

    const recommendations: Recommendation[] = [];

    for (const file of parsedFiles) {
      const fileStartTime = Date.now();
      this.logger.log(`Анализируем файл ${file.filePath} (${file.symbols.length} символов)`);

      const fileRecommendations = this.analyzeParsedFile(file);
      recommendations.push(...fileRecommendations);

      const fileDuration = Date.now() - fileStartTime;
      this.logger.log(`Файл ${file.filePath} проанализирован за ${fileDuration}ms: найдено ${fileRecommendations.length} рекомендаций`);

      if (logLevel === 'detailed' && fileRecommendations.length > 0) {
        this.logger.debug(`Рекомендации для файла ${file.filePath}:`, {
          count: fileRecommendations.length,
          byCategory: fileRecommendations.reduce((acc, r) => {
            acc[r.category] = (acc[r.category] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          byPriority: fileRecommendations.reduce((acc, r) => {
            acc[r.priority] = (acc[r.priority] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        });
      }
    }

    const totalDuration = Date.now() - startTime;
    const stats = this.calculateRecommendationStats(recommendations);

    this.logger.log(`Анализ рекомендаций для проекта ${projectId} завершен за ${totalDuration}ms: найдено ${recommendations.length} рекомендаций`);

    if (logLevel === 'detailed') {
      this.logger.debug('Статистика рекомендаций:', {
        projectId,
        totalRecommendations: recommendations.length,
        byCategory: stats.byCategory,
        byPriority: stats.byPriority,
        totalDuration,
      });
    } else {
      this.logger.log(`Рекомендации по категориям: ${Object.entries(stats.byCategory).map(([cat, count]) => `${cat}: ${count}`).join(', ')}`);
    }

    return recommendations;
  }

  async analyzeFile(
    userId: string,
    projectId: string,
    filePath: string,
  ): Promise<Recommendation[]> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    const fullPath = `${project.extractedPath}/${filePath}`;

    const parsedFile = await this.astParserService.parseFile(fullPath);
    return this.analyzeParsedFile(parsedFile);
  }

  private analyzeParsedFile(parsedFile: ParsedFile): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Анализируем каждый символ
    for (const symbol of parsedFile.symbols) {
      const symbolRecommendations = this.analyzeSymbol(symbol, parsedFile);
      recommendations.push(...symbolRecommendations);
    }

    // Анализируем общую структуру файла
    const fileRecommendations = this.analyzeFileStructure(parsedFile);
    recommendations.push(...fileRecommendations);

    return recommendations;
  }

  private analyzeSymbol(
    symbol: CodeSymbol,
    parsedFile: ParsedFile,
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Анализ сложности функций
    if (symbol.type === 'function' || symbol.type === 'method') {
      const complexity = this.calculateComplexity(symbol.code);

      if (complexity > 10) {
        recommendations.push({
          id: `complex-function-${symbol.name}`,
          category: 'MAINTAINABILITY',
          priority: 'HIGH',
          title: 'Слишком сложная функция',
          description: `Функция ${symbol.name} имеет высокую цикломатическую сложность (${complexity})`,
          filePath: parsedFile.filePath,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          codeSnippet: symbol.code,
          suggestion:
            'Разбейте функцию на более мелкие функции с единственной ответственностью',
          impact: 'Улучшит читаемость и тестируемость кода',
        });
      }

      if (complexity > 5) {
        recommendations.push({
          id: `moderate-complexity-${symbol.name}`,
          category: 'MAINTAINABILITY',
          priority: 'MEDIUM',
          title: 'Умеренно сложная функция',
          description: `Функция ${symbol.name} имеет умеренную сложность (${complexity})`,
          filePath: parsedFile.filePath,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          codeSnippet: symbol.code,
          suggestion:
            'Рассмотрите возможность рефакторинга для упрощения логики',
          impact: 'Улучшит поддерживаемость кода',
        });
      }
    }

    // Анализ длинных функций
    const lineCount = symbol.lineEnd - symbol.lineStart + 1;
    if (lineCount > 50) {
      recommendations.push({
        id: `long-function-${symbol.name}`,
        category: 'MAINTAINABILITY',
        priority: 'MEDIUM',
        title: 'Слишком длинная функция',
        description: `Функция ${symbol.name} содержит ${lineCount} строк`,
        filePath: parsedFile.filePath,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        codeSnippet: symbol.code,
        suggestion: 'Разбейте функцию на более мелкие функции',
        impact: 'Улучшит читаемость и тестируемость',
      });
    }

    // Анализ параметров функций
    if (symbol.type === 'function' || symbol.type === 'method') {
      const paramCount = this.countParameters(symbol.code);
      if (paramCount > 5) {
        recommendations.push({
          id: `many-params-${symbol.name}`,
          category: 'MAINTAINABILITY',
          priority: 'MEDIUM',
          title: 'Слишком много параметров',
          description: `Функция ${symbol.name} принимает ${paramCount} параметров`,
          filePath: parsedFile.filePath,
          lineStart: symbol.lineStart,
          lineEnd: symbol.lineEnd,
          codeSnippet: symbol.code,
          suggestion: 'Используйте объект параметров или паттерн Builder',
          impact: 'Упростит вызов функции и улучшит читаемость',
        });
      }
    }

    // Анализ вложенности
    const nestingLevel = this.calculateNestingLevel(symbol.code);
    if (nestingLevel > 4) {
      recommendations.push({
        id: `deep-nesting-${symbol.name}`,
        category: 'MAINTAINABILITY',
        priority: 'HIGH',
        title: 'Слишком глубокая вложенность',
        description: `Функция ${symbol.name} имеет ${nestingLevel} уровней вложенности`,
        filePath: parsedFile.filePath,
        lineStart: symbol.lineStart,
        lineEnd: symbol.lineEnd,
        codeSnippet: symbol.code,
        suggestion:
          'Используйте early return или извлеките вложенную логику в отдельные функции',
        impact: 'Улучшит читаемость и уменьшит сложность',
      });
    }

    return recommendations;
  }

  private analyzeFileStructure(parsedFile: ParsedFile): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Анализ размера файла
    const lineCount = parsedFile.lines.length;
    if (lineCount > 500) {
      recommendations.push({
        id: `large-file-${parsedFile.filePath}`,
        category: 'MAINTAINABILITY',
        priority: 'MEDIUM',
        title: 'Слишком большой файл',
        description: `Файл содержит ${lineCount} строк`,
        filePath: parsedFile.filePath,
        suggestion:
          'Рассмотрите возможность разделения файла на более мелкие модули',
        impact: 'Улучшит навигацию и поддерживаемость кода',
      });
    }

    // Анализ количества функций в файле
    const functionCount = parsedFile.symbols.filter(
      (s) => s.type === 'function' || s.type === 'method',
    ).length;
    if (functionCount > 20) {
      recommendations.push({
        id: `many-functions-${parsedFile.filePath}`,
        category: 'MAINTAINABILITY',
        priority: 'LOW',
        title: 'Много функций в одном файле',
        description: `Файл содержит ${functionCount} функций`,
        filePath: parsedFile.filePath,
        suggestion:
          'Рассмотрите возможность группировки связанных функций в отдельные модули',
        impact: 'Улучшит организацию кода и его переиспользование',
      });
    }

    // Анализ комментариев
    const commentLines = parsedFile.lines.filter(
      (line) =>
        line.trim().startsWith('//') ||
        line.trim().startsWith('/*') ||
        line.trim().startsWith('#') ||
        line.trim().startsWith('*'),
    ).length;

    const commentRatio = commentLines / lineCount;
    if (commentRatio < 0.1 && lineCount > 100) {
      recommendations.push({
        id: `low-comments-${parsedFile.filePath}`,
        category: 'MAINTAINABILITY',
        priority: 'LOW',
        title: 'Недостаточно комментариев',
        description: `Файл содержит мало комментариев (${Math.round(commentRatio * 100)}%)`,
        filePath: parsedFile.filePath,
        suggestion: 'Добавьте комментарии для сложной логики и публичных API',
        impact: 'Улучшит понимание кода другими разработчиками',
      });
    }

    return recommendations;
  }

  private calculateComplexity(code: string): number {
    let complexity = 1;

    const complexityPatterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bwhile\b/g,
      /\bfor\b/g,
      /\bswitch\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\?\s*[^:]*\s*:/g,
      /\|\|/g,
      /&&/g,
    ];

    for (const pattern of complexityPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return complexity;
  }

  private countParameters(code: string): number {
    // Простой подсчет параметров в скобках функции
    const paramMatch = code.match(/\([^)]*\)/);
    if (!paramMatch) return 0;

    const params = paramMatch[0].slice(1, -1).split(',');
    return params.filter((param) => param.trim()).length;
  }

  private calculateNestingLevel(code: string): number {
    let maxNesting = 0;
    let currentNesting = 0;

    for (const char of code) {
      if (char === '{' || char === '(') {
        currentNesting++;
        maxNesting = Math.max(maxNesting, currentNesting);
      } else if (char === '}' || char === ')') {
        currentNesting--;
      }
    }

    return maxNesting;
  }

  async getRecommendationsForProject(
    userId: string,
    projectId: string,
    filters: {
      category?: string;
      priority?: 'HIGH' | 'MEDIUM' | 'LOW';
      filePath?: string;
    } = {},
  ): Promise<{
    recommendations: Recommendation[];
    stats: {
      total: number;
      byPriority: { HIGH: number; MEDIUM: number; LOW: number };
      byCategory: Record<string, number>;
    };
  }> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Получаем рекомендации для проекта ${projectId} пользователя ${userId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры запроса рекомендаций:', {
        userId,
        projectId,
        filters,
      });
    }

    // Проверяем права пользователя на проект
    await this.projectsService.findByIdForUser(userId, projectId);

    // Ищем последний завершенный анализ типа RECOMMENDATION или FULL
    const analysisReport = await this.databaseService.analysisReport.findFirst({
      where: {
        projectId,
        type: {
          in: [AnalysisType.RECOMMENDATION, AnalysisType.FULL],
        },
        status: AnalysisStatus.COMPLETED,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!analysisReport) {
      throw new NotFoundException('Не найдено завершенных анализов типа RECOMMENDATION или FULL для данного проекта');
    }

    this.logger.log(`Найден анализ ${analysisReport.id} типа ${analysisReport.type} от ${analysisReport.createdAt}`);

    // Извлекаем рекомендации из результата анализа
    const result = analysisReport.result as any;
    let recommendations: Recommendation[] = [];

    if (result?.recommendations) {
      if (Array.isArray(result.recommendations)) {
        // Для анализа типа RECOMMENDATION
        recommendations = result.recommendations;
      } else if (result.recommendations.items && Array.isArray(result.recommendations.items)) {
        // Для анализа типа FULL
        recommendations = result.recommendations.items;
      }
    }

    this.logger.log(`Извлечено ${recommendations.length} рекомендаций из анализа ${analysisReport.id}`);

    // Применяем фильтры
    let filteredRecommendations = recommendations;

    if (filters.category) {
      filteredRecommendations = filteredRecommendations.filter(
        (rec) => rec.category.toLowerCase() === filters.category!.toLowerCase(),
      );
    }

    if (filters.priority) {
      filteredRecommendations = filteredRecommendations.filter(
        (rec) => rec.priority === filters.priority,
      );
    }

    if (filters.filePath) {
      filteredRecommendations = filteredRecommendations.filter(
        (rec) => rec.filePath.includes(filters.filePath!),
      );
    }

    // Удаляем дубликаты по id
    const uniqueRecommendations = filteredRecommendations.filter(
      (rec, index, self) => index === self.findIndex((r) => r.id === rec.id),
    );

    // Вычисляем статистику
    const stats = this.calculateRecommendationStats(uniqueRecommendations);

    const duration = Date.now() - startTime;
    this.logger.log(`Рекомендации для проекта ${projectId} получены за ${duration}ms: ${uniqueRecommendations.length} рекомендаций после фильтрации`);

    if (logLevel === 'detailed') {
      this.logger.debug('Статистика рекомендаций:', {
        projectId,
        totalRecommendations: uniqueRecommendations.length,
        byCategory: stats.byCategory,
        byPriority: stats.byPriority,
        filters,
        duration,
      });
    }

    return {
      recommendations: uniqueRecommendations,
      stats: {
        total: uniqueRecommendations.length,
        byPriority: {
          HIGH: stats.byPriority.HIGH || 0,
          MEDIUM: stats.byPriority.MEDIUM || 0,
          LOW: stats.byPriority.LOW || 0,
        },
        byCategory: stats.byCategory,
      },
    };
  }

  private calculateRecommendationStats(recommendations: Recommendation[]): {
    byCategory: Record<string, number>;
    byPriority: Record<string, number>;
  } {
    const byCategory: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    for (const rec of recommendations) {
      byCategory[rec.category] = (byCategory[rec.category] || 0) + 1;
      byPriority[rec.priority] = (byPriority[rec.priority] || 0) + 1;
    }

    return { byCategory, byPriority };
  }
}
