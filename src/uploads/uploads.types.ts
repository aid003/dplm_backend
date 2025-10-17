import { ReadStream } from 'node:fs';

export type ProgressPhase = 'queued' | 'extracting' | 'done' | 'error';

export interface ProgressEvent {
  jobId: string;
  phase: ProgressPhase;
  percent: number; // 0..100
  message?: string;
}

export interface ExtractionState {
  jobId: string;
  zipPath: string;
  targetDir: string;
  totalUncompressedBytes: number;
  processedBytes: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface SseEvent<TData> {
  data: TData;
  id?: string;
  event?: string;
  /** milliseconds for client reconnection */
  retry?: number;
}

export interface UploadedZipFile {
  originalName: string;
  path: string;
  size: number;
  stream?: ReadStream;
}

export interface StorageConfig {
  baseDir: string; // e.g. storage
  uploadsDir: string; // e.g. storage/uploads
  extractedDir: string; // e.g. storage/extracted
  ttlMs: number; // TTL for files cleanup
}
