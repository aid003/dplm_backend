import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { ProjectsService } from '../../projects/projects.service';
import { OpenAIService } from './openai.service';
import { AstParserService } from './ast-parser.service';
import { WeaviateService } from './weaviate.service';
import { promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';
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
    private readonly weaviateService: WeaviateService,
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

    // Используем Weaviate для индексации
    const result = await this.weaviateService.indexProject(
      projectId,
      projectPath,
      languages,
      this.openaiService,
    );

    const duration = Date.now() - startTime;
    this.logger.log(`Индексация проекта ${projectId} завершена за ${duration}ms: проиндексировано ${result.indexedFiles}, пропущено ${result.skippedFiles}, ошибок ${result.errors}`);

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

    // Используем Weaviate для векторного поиска
    const results = await this.weaviateService.searchRelevantFiles(
      projectId,
      query,
      limit,
      this.openaiService,
    );

    const duration = Date.now() - startTime;
    this.logger.log(`Поиск завершен за ${duration}ms: найдено ${results.length} релевантных файлов`);

    if (logLevel === 'detailed') {
      this.logger.debug('Результаты поиска:', {
        query,
        projectId,
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
    return this.weaviateService.getIndexStatus(projectId);
  }

  async clearIndex(projectId: string): Promise<void> {
    this.logger.log(`Очищаем индекс для проекта ${projectId}`);
    
    await this.weaviateService.clearIndex(projectId);
  }

}
