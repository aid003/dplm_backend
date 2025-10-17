import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

export async function ensureDirectoryExists(
  directoryPath: string,
): Promise<void> {
  await fsp.mkdir(directoryPath, { recursive: true });
}

export function toSafeRelativePath(entryPath: string): string {
  const normalized = normalize(entryPath).replace(/^\\+/g, '');
  if (normalized.includes('..')) {
    throw new Error('Unsafe path: path traversal is not allowed');
  }
  if (isAbsolute(normalized)) {
    throw new Error('Unsafe path: absolute paths are not allowed');
  }
  return normalized;
}

export function ensurePathInside(baseDir: string, targetPath: string): string {
  const absoluteBase = resolve(baseDir);
  const absoluteTarget = resolve(targetPath);
  if (!absoluteTarget.startsWith(absoluteBase + '/')) {
    throw new Error('Unsafe path: target escapes base directory');
  }
  return absoluteTarget;
}

export async function writeStreamWithProgress(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  onChunk: (size: number) => void,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    input.on('data', (chunk: Buffer) => {
      onChunk(chunk.length);
    });
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', () => resolvePromise());
    input.pipe(output);
  });
}

export async function readFileSignature(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1 });
  const chunks: Buffer[] = [];
  return new Promise((resolvePromise, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
  });
}
