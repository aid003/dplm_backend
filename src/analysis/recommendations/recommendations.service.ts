import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { AstParserService } from '../explanation/ast-parser.service';

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
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    const languages = options.languages || [
      'typescript',
      'javascript',
      'python',
    ];

    const parsedFiles = await this.astParserService.parseProject(
      project.extractedPath,
      languages,
    );
    const recommendations: Recommendation[] = [];

    for (const file of parsedFiles) {
      const fileRecommendations = this.analyzeParsedFile(file);
      recommendations.push(...fileRecommendations);
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
}
