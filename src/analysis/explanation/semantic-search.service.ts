import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { OpenAIService } from './openai.service';
import { AstParserService } from './ast-parser.service';
import { promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';
import type { FileIndex } from '../../../generated/prisma';
import { isDevelopment, getLogLevel } from '../utils/environment.util';

export interface FileSearchResult {
  filePath: string;
  summary: string;
  language: string;
  similarity: number;
  fileSize: number;
}

export interface IndexingResult {
  indexedFiles: number;
  skippedFiles: number;
  errors: number;
  duration: number;
}

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly projectsService: ProjectsService,
    private readonly openaiService: OpenAIService,
    private readonly astParserService: AstParserService,
  ) {}

  async indexProject(
    userId: string,
    projectId: string,
    languages: string[] = ['typescript', 'javascript', 'python', 'go'],
  ): Promise<IndexingResult> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем индексацию проекта ${projectId} для пользователя ${userId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры индексации:', {
        userId,
        projectId,
        languages,
      });
    }

    const project = await this.projectsService.findByIdForUser(userId, projectId);
    const projectPath = project.extractedPath;

    // Получаем список файлов для индексации
    const filesToIndex = await this.findSourceFiles(projectPath, languages);
    this.logger.log(`Найдено ${filesToIndex.length} файлов для индексации`);

    let indexedFiles = 0;
    let skippedFiles = 0;
    let errors = 0;

    // Проверяем существующие индексы
    const existingIndexes = await this.databaseService.fileIndex.findMany({
      where: { projectId },
      select: { filePath: true, lastModified: true },
    });

    const existingIndexMap = new Map(
      existingIndexes.map(idx => [idx.filePath, idx.lastModified])
    );

    for (const filePath of filesToIndex) {
      try {
        const relativePath = filePath.replace(projectPath + '/', '');
        const stats = await fsp.stat(filePath);
        const existingIndex = existingIndexMap.get(relativePath);

        // Пропускаем файл, если он уже проиндексирован и не изменился
        if (existingIndex && existingIndex.getTime() >= stats.mtime.getTime()) {
          skippedFiles++;
          continue;
        }

        // Читаем содержимое файла
        const content = await fsp.readFile(filePath, 'utf-8');
        const language = this.detectLanguage(filePath);

        // Генерируем краткое описание файла
        const summary = await this.openaiService.generateFileSummary(relativePath, content);
        
        // Создаем embedding
        const embedding = await this.openaiService.createEmbedding(summary);

        // Сохраняем или обновляем индекс
        await this.databaseService.fileIndex.upsert({
          where: {
            projectId_filePath: {
              projectId,
              filePath: relativePath,
            },
          },
          update: {
            summary,
            embedding: embedding as any,
            language,
            fileSize: stats.size,
            lastModified: stats.mtime,
            updatedAt: new Date(),
          },
          create: {
            projectId,
            filePath: relativePath,
            summary,
            embedding: embedding as any,
            language,
            fileSize: stats.size,
            lastModified: stats.mtime,
          },
        });

        indexedFiles++;

        if (logLevel === 'detailed') {
          this.logger.debug(`Проиндексирован файл: ${relativePath}`, {
            language,
            size: stats.size,
            summary: summary.substring(0, 100) + '...',
          });
        }

      } catch (error) {
        errors++;
        this.logger.warn(`Ошибка при индексации файла ${filePath}:`, error);
      }
    }

    const duration = Date.now() - startTime;
    const result: IndexingResult = {
      indexedFiles,
      skippedFiles,
      errors,
      duration,
    };

    this.logger.log(`Индексация проекта ${projectId} завершена за ${duration}ms: проиндексировано ${indexedFiles}, пропущено ${skippedFiles}, ошибок ${errors}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Результаты индексации:', {
        projectId,
        ...result,
      });
    }

    return result;
  }

  async searchRelevantFiles(
    userId: string,
    projectId: string,
    query: string,
    limit: number = 10,
  ): Promise<FileSearchResult[]> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Поиск релевантных файлов для запроса: "${query}" в проекте ${projectId}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры поиска:', {
        userId,
        projectId,
        query,
        limit,
      });
    }

    // Проверяем права доступа к проекту
    await this.projectsService.findByIdForUser(userId, projectId);

    // Создаем embedding для запроса
    const queryEmbedding = await this.openaiService.createEmbedding(query);

    // Получаем все индексы файлов проекта
    const fileIndexes = await this.databaseService.fileIndex.findMany({
      where: { projectId },
      select: {
        filePath: true,
        summary: true,
        language: true,
        embedding: true,
        fileSize: true,
      },
    });

    if (fileIndexes.length === 0) {
      this.logger.warn(`Нет проиндексированных файлов для проекта ${projectId}`);
      return [];
    }

    // Вычисляем схожесть для каждого файла
    const similarities: Array<FileSearchResult & { embedding: number[] }> = [];

    for (const fileIndex of fileIndexes) {
      const embedding = fileIndex.embedding as number[];
      const similarity = this.openaiService.calculateCosineSimilarity(queryEmbedding, embedding);

      similarities.push({
        filePath: fileIndex.filePath,
        summary: fileIndex.summary,
        language: fileIndex.language,
        similarity,
        fileSize: fileIndex.fileSize,
        embedding,
      });
    }

    // Сортируем по схожести и берем топ-N
    const results = similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(({ embedding, ...result }) => result);

    const duration = Date.now() - startTime;
    this.logger.log(`Поиск завершен за ${duration}ms: найдено ${results.length} релевантных файлов`);

    if (logLevel === 'detailed') {
      this.logger.debug('Результаты поиска:', {
        query,
        projectId,
        totalFiles: fileIndexes.length,
        resultsCount: results.length,
        topResults: results.slice(0, 3).map(r => ({
          filePath: r.filePath,
          similarity: r.similarity,
          summary: r.summary.substring(0, 100) + '...',
        })),
        duration,
      });
    }

    return results;
  }

  async getIndexStatus(projectId: string): Promise<{
    totalFiles: number;
    lastIndexed: Date | null;
    languages: Record<string, number>;
  }> {
    const indexes = await this.databaseService.fileIndex.findMany({
      where: { projectId },
      select: {
        language: true,
        updatedAt: true,
      },
    });

    const languages = indexes.reduce((acc, idx) => {
      acc[idx.language] = (acc[idx.language] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const lastIndexed = indexes.length > 0 
      ? new Date(Math.max(...indexes.map(idx => idx.updatedAt.getTime())))
      : null;

    return {
      totalFiles: indexes.length,
      lastIndexed,
      languages,
    };
  }

  async clearIndex(projectId: string): Promise<void> {
    this.logger.log(`Очищаем индекс для проекта ${projectId}`);
    
    const deleted = await this.databaseService.fileIndex.deleteMany({
      where: { projectId },
    });

    this.logger.log(`Удалено ${deleted.count} записей индекса для проекта ${projectId}`);
  }

  private async findSourceFiles(
    projectPath: string,
    languages: string[],
  ): Promise<string[]> {
    const files: string[] = [];
    const extensions = this.getExtensionsForLanguages(languages);

    await this.walkDirectory(projectPath, files, extensions);
    return files;
  }

  private getExtensionsForLanguages(languages: string[]): string[] {
    const extensionMap: Record<string, string[]> = {
      typescript: ['.ts', '.tsx'],
      javascript: ['.js', '.jsx'],
      python: ['.py'],
      java: ['.java'],
      go: ['.go'],
    };

    const extensions: string[] = [];
    for (const lang of languages) {
      if (extensionMap[lang]) {
        extensions.push(...extensionMap[lang]);
      }
    }

    return extensions;
  }

  private async walkDirectory(
    dir: string,
    files: string[],
    extensions: string[],
  ): Promise<void> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Пропускаем служебные директории
          if (
            ![
              'node_modules',
              '.git',
              'dist',
              'build',
              '.next',
              '.turbo',
              'coverage',
              '.nyc_output',
            ].includes(entry.name)
          ) {
            await this.walkDirectory(fullPath, files, extensions);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Не удалось прочитать директорию ${dir}:`, error);
    }
  }

  private detectLanguage(filePath: string): string {
    const ext = extname(filePath).toLowerCase();

    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.py':
        return 'python';
      case '.java':
        return 'java';
      case '.go':
        return 'go';
      default:
        return 'unknown';
    }
  }
}
