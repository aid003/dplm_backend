import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import weaviate, { WeaviateClient } from 'weaviate-client';
import type { WeaviateField } from 'weaviate-client';
import { promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';
import { getLogLevel } from '../utils/environment.util';

export interface ProjectFile {
  projectId: string;
  filePath: string;
  summary: string;
  language: string;
  fileSize: number;
  lastModified: Date;
  embedding?: number[];
}

export interface IndexingResult {
  indexedFiles: number;
  skippedFiles: number;
  errors: number;
  duration: number;
}

export interface SearchResult {
  filePath: string;
  summary: string;
  language: string;
  similarity: number;
  fileSize: number;
}

interface EmbeddingProvider {
  generateFileSummary(filePath: string, content: string): Promise<string>;
  createEmbedding(text: string): Promise<number[]>;
}

interface WeaviateDocumentProperties {
  projectId: string;
  filePath: string;
  summary: string;
  language: string;
  fileSize: number;
  lastModified: string;
}

interface WeaviateFetchedObject {
  uuid: string;
  properties?: Partial<WeaviateDocumentProperties> & Record<string, unknown>;
  // In v3, some query responses include metadata fields like certainty
  metadata?: { certainty?: number } & Record<string, unknown>;
  // Back-compat properties (depending on driver behavior)
  filePath?: string;
  summary?: string;
  language?: string;
  fileSize?: number;
  lastModified?: string;
}

@Injectable()
export class WeaviateService implements OnModuleInit {
  private readonly logger = new Logger(WeaviateService.name);
  private client: WeaviateClient;
  private readonly isUsingOpenAIEmbeddings: boolean;
  private readonly weaviateUrl: string;
  private readonly weaviateApiKey?: string;
  private readonly className = 'ProjectFile';

  constructor(private readonly configService: ConfigService) {
    this.isUsingOpenAIEmbeddings =
      this.configService.get<string>('IS_USING_OPENAI_EMBEDDINGS') === '1';
    this.weaviateUrl =
      this.configService.get<string>('WEAVIATE_URL') || 'http://localhost:8080';
    this.weaviateApiKey = this.configService.get<string>('WEAVIATE_API_KEY');
  }

  async onModuleInit(): Promise<void> {
    await this.initializeClient();
    await this.ensureSchema();
  }

  private async initializeClient(): Promise<void> {
    const logLevel = getLogLevel();
    this.logger.log(`Инициализация Weaviate клиента: ${this.weaviateUrl}`);

    try {
      // Используем новый API weaviate-client v3
      this.client = await weaviate.connectToLocal();

      // Проверяем подключение
      const isReady = await this.client.isReady();

      if (logLevel === 'detailed') {
        this.logger.debug('Подключение к Weaviate установлено:', {
          isReady,
          usingOpenAIEmbeddings: this.isUsingOpenAIEmbeddings,
        });
      } else {
        this.logger.log(`Weaviate подключен (готов: ${isReady})`);
      }
    } catch (error) {
      this.logger.error('Ошибка при подключении к Weaviate:', error);
      throw new Error(
        `Не удалось подключиться к Weaviate: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  private async ensureSchema(): Promise<void> {
    const logLevel = getLogLevel();
    this.logger.log(`Проверяем схему коллекции ${this.className}`);

    try {
      // Проверяем, существует ли коллекция
      const collections = await this.client.collections.listAll();
      const existingCollection = collections.find(
        (col) => col.name === this.className,
      );

      if (existingCollection) {
        if (logLevel === 'detailed') {
          this.logger.debug('Коллекция уже существует:', {
            className: this.className,
            properties: existingCollection.properties?.length || 0,
          });
        } else {
          this.logger.log(`Коллекция ${this.className} уже существует`);
        }
        return;
      }

      // Создаем коллекцию с новым API
      await this.client.collections.create({
        name: this.className,
        // Для OpenAI embeddings не используем встроенный векторизатор
        // Встроенный векторизатор будет использоваться автоматически, если не указан
      });

      this.logger.log(`Коллекция ${this.className} создана успешно`);
    } catch (error) {
      this.logger.error(
        `Ошибка при создании схемы коллекции ${this.className}:`,
        error,
      );
      throw error;
    }
  }

  async indexProject(
    projectId: string,
    projectPath: string,
    languages: string[] = ['typescript', 'javascript', 'python', 'go'],
    openaiService?: EmbeddingProvider, // OpenAIService для генерации embeddings
  ): Promise<IndexingResult> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Начинаем индексацию проекта ${projectId} в Weaviate`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры индексации:', {
        projectId,
        projectPath,
        languages,
        usingOpenAIEmbeddings: this.isUsingOpenAIEmbeddings,
      });
    }

    // Получаем список файлов для индексации
    const filesToIndex = await this.findSourceFiles(projectPath, languages);
    this.logger.log(`Найдено ${filesToIndex.length} файлов для индексации`);

    let indexedFiles = 0;
    let skippedFiles = 0;
    let errors = 0;

    // Проверяем существующие документы
    const existingDocs = await this.getProjectDocuments(projectId);

    for (const filePath of filesToIndex) {
      try {
        const relativePath = filePath.replace(projectPath + '/', '');
        const stats = await fsp.stat(filePath);

        // Проверяем, нужно ли обновить документ
        const existingDoc = existingDocs.find(
          (doc) => doc.filePath === relativePath,
        );
        if (
          existingDoc &&
          new Date(existingDoc.lastModified).getTime() >= stats.mtime.getTime()
        ) {
          skippedFiles++;
          continue;
        }

        // Читаем содержимое файла
        const content = await fsp.readFile(filePath, 'utf-8');
        const language = this.detectLanguage(filePath);

        // Генерируем краткое описание файла
        let summary: string;
        let embedding: number[] | undefined;

        if (this.isUsingOpenAIEmbeddings && openaiService) {
          summary = await openaiService.generateFileSummary(
            relativePath,
            content,
          );
          embedding = await openaiService.createEmbedding(summary);
        } else {
          // Используем встроенный векторизатор Weaviate
          summary = this.generateBasicSummary(relativePath, content, language);
        }

        // Создаем объект для Weaviate
        const document: WeaviateDocumentProperties = {
          projectId,
          filePath: relativePath,
          summary,
          language,
          fileSize: stats.size,
          lastModified: stats.mtime.toISOString(),
        };

        // Сохраняем или обновляем документ
        if (existingDoc) {
          await this.updateDocument(existingDoc.uuid, document, embedding);
        } else {
          await this.createDocument(document, embedding);
        }

        indexedFiles++;

        if (logLevel === 'detailed') {
          this.logger.debug(`Проиндексирован файл: ${relativePath}`, {
            language,
            size: stats.size,
            summary: summary.substring(0, 100) + '...',
            hasEmbedding: !!embedding,
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

    this.logger.log(
      `Индексация проекта ${projectId} в Weaviate завершена за ${duration}ms: проиндексировано ${indexedFiles}, пропущено ${skippedFiles}, ошибок ${errors}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Результаты индексации:', {
        projectId,
        ...result,
      });
    }

    return result;
  }

  async searchRelevantFiles(
    projectId: string,
    query: string,
    limit: number = 10,
    openaiService?: EmbeddingProvider,
  ): Promise<SearchResult[]> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(
      `Поиск релевантных файлов для запроса: "${query}" в проекте ${projectId}`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры поиска:', {
        projectId,
        query,
        limit,
        usingOpenAIEmbeddings: this.isUsingOpenAIEmbeddings,
      });
    }

    try {
      const collection = this.client.collections.get(this.className);
      let searchResult: { objects?: WeaviateFetchedObject[] };

      if (this.isUsingOpenAIEmbeddings && openaiService) {
        // Используем OpenAI embeddings для поиска
        const queryEmbedding = await openaiService.createEmbedding(query);

        searchResult = await collection.query.nearVector(queryEmbedding, {
          limit: limit,
        });
      } else {
        // Используем встроенный векторизатор Weaviate
        searchResult = await collection.query.nearText(query, {
          limit: limit,
        });
      }

      const documents: WeaviateFetchedObject[] = searchResult.objects || [];

      const results: SearchResult[] = documents.map((doc) => ({
        filePath: (doc.properties?.filePath as string) || doc.filePath || '',
        summary: (doc.properties?.summary as string) || doc.summary || '',
        language:
          (doc.properties?.language as string) || doc.language || 'unknown',
        similarity: (doc.metadata?.certainty as number) || 0,
        fileSize:
          (doc.properties?.fileSize as number) || (doc.fileSize as number) || 0,
      }));

      const duration = Date.now() - startTime;
      this.logger.log(
        `Поиск завершен за ${duration}ms: найдено ${results.length} релевантных файлов`,
      );

      if (logLevel === 'detailed') {
        this.logger.debug('Результаты поиска:', {
          query,
          projectId,
          resultsCount: results.length,
          topResults: results.slice(0, 3).map((r) => ({
            filePath: r.filePath,
            similarity: r.similarity,
            summary: r.summary.substring(0, 100) + '...',
          })),
          duration,
        });
      }

      return results;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(`Ошибка при поиске в Weaviate (${duration}ms):`, error);
      throw error;
    }
  }

  async getIndexStatus(projectId: string): Promise<{
    totalFiles: number;
    lastIndexed: Date | null;
    languages: Record<string, number>;
  }> {
    try {
      const collection = this.client.collections.get(this.className);

      // Упрощенный запрос без фильтрации по projectId
      const result = await collection.query.fetchObjects({});

      const documents: WeaviateFetchedObject[] = result.objects || [];

      // Фильтруем по projectId в коде
      const projectDocuments = documents.filter(
        (doc) => doc.properties?.projectId === projectId,
      );

      const languages = projectDocuments.reduce(
        (acc: Record<string, number>, doc) => {
          const lang = (doc.properties?.language as string) || 'unknown';
          acc[lang] = (acc[lang] || 0) + 1;
          return acc;
        },
        {},
      );

      const lastIndexed =
        projectDocuments.length > 0
          ? new Date(
              Math.max(
                ...projectDocuments.map((doc) => {
                  const lm =
                    (doc.properties?.lastModified as string) ||
                    (doc.lastModified as string) ||
                    '';
                  return new Date(lm).getTime();
                }),
              ),
            )
          : null;

      return {
        totalFiles: projectDocuments.length,
        lastIndexed,
        languages,
      };
    } catch (error) {
      this.logger.error(
        `Ошибка при получении статуса индекса для проекта ${projectId}:`,
        error,
      );
      return {
        totalFiles: 0,
        lastIndexed: null,
        languages: {},
      };
    }
  }

  async clearIndex(projectId: string): Promise<void> {
    this.logger.log(`Очищаем индекс для проекта ${projectId} в Weaviate`);

    try {
      const collection = this.client.collections.get(this.className);

      // Получаем все документы
      const result = await collection.query.fetchObjects({});

      const documents: WeaviateFetchedObject[] = result.objects || [];

      // Фильтруем по projectId и удаляем
      const projectDocuments = documents.filter(
        (doc) => doc.properties?.projectId === projectId,
      );

      if (projectDocuments.length > 0) {
        // Удаляем документы по одному
        for (const doc of projectDocuments) {
          try {
            await collection.data.deleteById(doc.uuid);
          } catch (error) {
            this.logger.warn(`Не удалось удалить документ ${doc.uuid}:`, error);
          }
        }
      }

      this.logger.log(
        `Удалено ${projectDocuments.length} документов для проекта ${projectId}`,
      );
    } catch (error) {
      this.logger.error(
        `Ошибка при очистке индекса для проекта ${projectId}:`,
        error,
      );
      throw error;
    }
  }

  private async createDocument(
    document: WeaviateDocumentProperties,
    embedding?: number[],
  ): Promise<void> {
    const collection = this.client.collections.get(this.className);

    if (this.isUsingOpenAIEmbeddings && embedding) {
      // Для OpenAI embeddings передаем вектор напрямую
      await collection.data.insert({
        properties: document as unknown as Record<string, WeaviateField>,
        vectors: embedding,
      });
    } else {
      // Для встроенного векторизатора Weaviate
      await collection.data.insert({
        properties: document as unknown as Record<string, WeaviateField>,
      });
    }
  }

  private async updateDocument(
    documentId: string,
    document: WeaviateDocumentProperties,
    embedding?: number[],
  ): Promise<void> {
    const collection = this.client.collections.get(this.className);

    if (this.isUsingOpenAIEmbeddings && embedding) {
      // Для OpenAI embeddings передаем вектор напрямую
      await collection.data.update({
        id: documentId,
        properties: document as unknown as Partial<
          Record<string, WeaviateField>
        >,
        vectors: embedding,
      });
    } else {
      // Для встроенного векторизатора Weaviate
      await collection.data.update({
        id: documentId,
        properties: document as unknown as Partial<
          Record<string, WeaviateField>
        >,
      });
    }
  }

  private async getProjectDocuments(
    projectId: string,
  ): Promise<Array<{ uuid: string; filePath: string; lastModified: string }>> {
    const collection = this.client.collections.get(this.className);

    // Упрощенный запрос - получаем все документы и фильтруем в коде
    const result = await collection.query.fetchObjects({});

    const documents: WeaviateFetchedObject[] = result.objects || [];

    // Фильтруем по projectId и нормализуем поля
    return documents
      .filter((doc) => doc.properties?.projectId === projectId)
      .map((doc) => ({
        uuid: doc.uuid,
        filePath: (doc.properties?.filePath as string) || doc.filePath || '',
        lastModified:
          (doc.properties?.lastModified as string) || doc.lastModified || '',
      }));
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

  private generateBasicSummary(
    filePath: string,
    content: string,
    language: string,
  ): string {
    // Простое описание файла без использования OpenAI
    const lines = content.split('\n').length;
    const size = content.length;

    return `Файл ${filePath} на языке ${language}. Содержит ${lines} строк, ${size} символов. Основная функциональность требует анализа.`;
  }
}
