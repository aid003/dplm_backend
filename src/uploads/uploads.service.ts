import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { dirname, join, resolve } from 'node:path';
import { createWriteStream, promises as fsp } from 'node:fs';
import {
  setInterval as setNodeInterval,
  clearInterval as clearNodeInterval,
} from 'node:timers';
import { Subject } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { SemanticSearchService } from '../analysis/explanation/semantic-search.service';
import type {
  ProgressEvent,
  ExtractionState,
  StorageConfig,
} from './uploads.types';
import {
  ensureDirectoryExists,
  ensurePathInside,
  readFileSignature,
  toSafeRelativePath,
  writeStreamWithProgress,
} from './uploads.utils';

// We will use unzipper for streaming extraction (dynamic import)
// Типизируем локально, без прямой зависимости от типов пакета
interface UnzipperEntry {
  path: string;
  type: 'File' | 'Directory' | (string & {});
  uncompressedSize?: number;
  stream(): NodeJS.ReadableStream;
}

interface UnzipperModule {
  Open: {
    file(path: string): Promise<{ files: UnzipperEntry[] }>;
  };
}

function isUnzipperModule(value: unknown): value is UnzipperModule {
  if (typeof value !== 'object' || value === null) return false;
  const maybe = value as { Open?: { file?: unknown } };
  return (
    typeof maybe.Open === 'object' &&
    maybe.Open !== null &&
    typeof maybe.Open.file === 'function'
  );
}

@Injectable()
export class UploadsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadsService.name);

  private readonly subjectsByJobId = new Map<string, Subject<ProgressEvent>>();
  private readonly stateByJobId = new Map<string, ExtractionState>();
  private cleanupInterval?: ReturnType<typeof setNodeInterval>;

  private readonly config: StorageConfig = {
    baseDir: resolve('storage'),
    uploadsDir: resolve('storage/uploads'),
    extractedDir: resolve('storage/extracted'),
    ttlMs: 1000 * 60 * 60 * 24, // 24h
  };

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly semanticSearchService: SemanticSearchService,
  ) {}

  async onModuleInit(): Promise<void> {
    await ensureDirectoryExists(this.config.baseDir);
    await ensureDirectoryExists(this.config.uploadsDir);
    await ensureDirectoryExists(this.config.extractedDir);
    this.cleanupInterval = setNodeInterval(
      () => {
        void this.cleanupOldFiles();
      },
      Math.min(this.config.ttlMs, 1000 * 60 * 15),
    ); // не реже 15 минут
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) clearNodeInterval(this.cleanupInterval);
  }

  getStorageConfig(): StorageConfig {
    return this.config;
  }

  getOrCreateSubject(jobId: string): Subject<ProgressEvent> {
    let subject = this.subjectsByJobId.get(jobId);
    if (!subject) {
      subject = new Subject<ProgressEvent>();
      this.subjectsByJobId.set(jobId, subject);
    }
    return subject;
  }

  private emit(jobId: string, event: ProgressEvent): void {
    const subject = this.subjectsByJobId.get(jobId);
    subject?.next(event);
  }

  private complete(jobId: string): void {
    const subject = this.subjectsByJobId.get(jobId);
    subject?.complete();
    this.subjectsByJobId.delete(jobId);
    this.stateByJobId.delete(jobId);
  }

  async validateZipSignature(filePath: string): Promise<void> {
    const header = await readFileSignature(filePath, 4);
    const isZip =
      header.length >= 4 &&
      header[0] === 0x50 &&
      header[1] === 0x4b &&
      header[2] === 0x03 &&
      header[3] === 0x04;
    if (!isZip) {
      throw new Error('Invalid ZIP file signature');
    }
  }

  async saveUploadedFile(
    tempPath: string,
    destinationPath: string,
  ): Promise<void> {
    await ensureDirectoryExists(dirname(destinationPath));
    await fsp.rename(tempPath, destinationPath);
  }

  async startExtraction(
    jobId: string,
    zipPath: string,
    targetDir: string,
  ): Promise<void> {
    const mod: unknown = await import('unzipper');
    if (!isUnzipperModule(mod)) {
      throw new Error('Invalid unzipper module loaded');
    }
    const unzipper = mod;
    await ensureDirectoryExists(targetDir);

    const { files: entries } = await unzipper.Open.file(zipPath);
    const total = entries.reduce(
      (sum: number, f: UnzipperEntry) => sum + (f.uncompressedSize ?? 0),
      0,
    );
    const state: ExtractionState = {
      jobId,
      zipPath,
      targetDir,
      totalUncompressedBytes: total,
      processedBytes: 0,
      startedAt: Date.now(),
    };
    this.stateByJobId.set(jobId, state);

    this.emit(jobId, { jobId, phase: 'extracting', percent: 0 });

    try {
      for (const entry of entries) {
        if (entry.type === 'Directory') continue;
        const safeRelPath = toSafeRelativePath(entry.path);
        const outPath = ensurePathInside(
          targetDir,
          join(targetDir, safeRelPath),
        );
        await ensureDirectoryExists(dirname(outPath));
        const readStream = entry.stream();
        const writeStream = createWriteStream(outPath);
        await writeStreamWithProgress(readStream, writeStream, (n) => {
          state.processedBytes += n;
          const percent =
            state.totalUncompressedBytes > 0
              ? Math.min(
                  99,
                  Math.floor(
                    (state.processedBytes / state.totalUncompressedBytes) * 100,
                  ),
                )
              : 0;
          this.emit(jobId, { jobId, phase: 'extracting', percent });
        });
      }
      state.finishedAt = Date.now();
      this.emit(jobId, { jobId, phase: 'done', percent: 100 });
      // Обновим статус проекта до READY по jobId
      try {
        await this.databaseService.updateProjectStatusByJobId(jobId, 'READY');

        // Запускаем автоматическую индексацию проекта в фоне
        void this.startProjectIndexing(jobId);
      } catch (e) {
        this.logger.warn(
          `Failed to set project READY for job ${jobId}: ${String(e)}`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      state.error = message;
      this.emit(jobId, {
        jobId,
        phase: 'error',
        percent: Math.min(
          99,
          Math.floor(
            (state.processedBytes / Math.max(1, state.totalUncompressedBytes)) *
              100,
          ),
        ),
        message,
      });
      // Обновим статус проекта до ERROR по jobId
      try {
        await this.databaseService.updateProjectStatusByJobId(jobId, 'ERROR');
      } catch (e) {
        this.logger.warn(
          `Failed to set project ERROR for job ${jobId}: ${String(e)}`,
        );
      }
    } finally {
      this.complete(jobId);
    }
  }

  async removeProjectArtifacts(
    zipPath: string,
    extractedPath: string,
  ): Promise<void> {
    const targets: string[] = [];
    try {
      const safeZip = ensurePathInside(this.config.uploadsDir, zipPath);
      targets.push(safeZip);
    } catch (e) {
      this.logger.warn(`Zip path skipped as unsafe: ${String(e)}`);
    }
    try {
      const safeExtracted = ensurePathInside(
        this.config.extractedDir,
        extractedPath,
      );
      targets.push(safeExtracted);
    } catch (e) {
      this.logger.warn(`Extracted path skipped as unsafe: ${String(e)}`);
    }
    if (targets.length === 0) return;
    await Promise.allSettled(
      targets.map((p) => fsp.rm(p, { recursive: true, force: true })),
    );
  }

  private async startProjectIndexing(jobId: string): Promise<void> {
    try {
      this.logger.log(`Запускаем автоматическую индексацию для job ${jobId}`);

      // Получаем информацию о проекте по jobId
      const project = await this.databaseService.project.findUnique({
        where: { jobId },
        select: { id: true, userId: true, name: true },
      });

      if (!project) {
        this.logger.warn(`Проект не найден для job ${jobId}`);
        return;
      }

      this.logger.log(
        `Начинаем индексацию проекта ${project.name} (${project.id}) для пользователя ${project.userId}`,
      );

      // Запускаем индексацию в фоне
      const result = await this.semanticSearchService.indexProject(
        project.userId,
        project.id,
        ['typescript', 'javascript', 'python', 'go'],
      );

      this.logger.log(
        `Автоматическая индексация проекта ${project.id} завершена: проиндексировано ${result.indexedFiles} файлов, пропущено ${result.skippedFiles}, ошибок ${result.errors}`,
      );
    } catch (error) {
      this.logger.error(
        `Ошибка при автоматической индексации проекта для job ${jobId}:`,
        error,
      );
      // Не прерываем основной процесс из-за ошибки индексации
    }
  }

  private async cleanupOldFiles(): Promise<void> {
    const now = Date.now();
    const limit = this.config.ttlMs;

    const tryRemove = async (targetPath: string): Promise<void> => {
      try {
        await fsp.rm(targetPath, { recursive: true, force: true });
      } catch (e) {
        this.logger.warn(`Failed to remove ${targetPath}: ${String(e)}`);
      }
    };

    const scanDir = async (dir: string): Promise<void> => {
      let entries: {
        name: string;
        path: string;
        isDirectory: boolean;
        mtimeMs: number;
      }[] = [];
      try {
        const list = await fsp.readdir(dir, { withFileTypes: true });
        const mapped = await Promise.all(
          list.map(async (d) => {
            const p = join(dir, d.name);
            const st = await fsp.stat(p);
            return {
              name: d.name,
              path: p,
              isDirectory: d.isDirectory(),
              mtimeMs: st.mtimeMs,
            };
          }),
        );
        entries = mapped;
      } catch (e) {
        this.logger.warn(`Cleanup scan failed for ${dir}: ${String(e)}`);
        return;
      }

      await Promise.all(
        entries.map(async (e) => {
          const age = now - e.mtimeMs;
          if (age > limit) {
            await tryRemove(e.path);
          } else if (e.isDirectory) {
            await scanDir(e.path);
          }
        }),
      );
    };

    await scanDir(this.config.uploadsDir);
    await scanDir(this.config.extractedDir);
  }
}
