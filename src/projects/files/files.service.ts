import { Injectable, BadRequestException } from '@nestjs/common';
import { promises as fsp, Dirent } from 'node:fs';
import { join, dirname } from 'node:path';
import { ProjectsService } from '../projects.service';
import {
  ensureDirectoryExists,
  ensurePathInside,
  toSafeRelativePath,
} from '../../uploads/uploads.utils';
import { lookup as mimeLookup } from 'mime-types';

export interface FilePosition {
  line: number;
  character: number;
}

export type FileNode =
  | {
      path: string;
      name: string;
      type: 'file';
      size: number;
    }
  | {
      path: string;
      name: string;
      type: 'directory';
      children?: FileNode[];
    };

export type FileContentResponse =
  | {
      isBinary: false;
      content: string;
      encoding: 'utf-8';
      size: number;
    }
  | {
      isBinary: true;
      base64: string;
      mimeType: string;
      size: number;
    };

export interface CreateEntryBody {
  path: string;
  type: 'file' | 'directory';
  content?: string;
}

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
]);

const MAX_TEXT_FILE_BYTES = 1_000_000; // ~1MB

@Injectable()
export class ProjectFilesService {
  constructor(private readonly projectsService: ProjectsService) {}

  private readonly treeCache = new Map<
    string,
    { expiresAt: number; nodes: FileNode[] }
  >();
  private static readonly TREE_TTL_MS = 7_000; // 7 секунд

  private async getProjectRootDir(
    userId: string,
    projectId: string,
  ): Promise<string> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    return project.extractedPath;
  }

  private resolveAndValidatePath(
    rootDir: string,
    relativePath: string,
  ): string {
    const safeRel = toSafeRelativePath(relativePath);
    const abs = ensurePathInside(rootDir, join(rootDir, safeRel));
    return abs;
  }

  async getFileTree(
    userId: string,
    projectId: string,
    subPath?: string,
  ): Promise<FileNode[]> {
    const rootDir = await this.getProjectRootDir(userId, projectId);
    const baseDir = subPath
      ? this.resolveAndValidatePath(rootDir, subPath)
      : rootDir;
    const baseRel = subPath ? toSafeRelativePath(subPath) : '';
    const cacheKey = `${projectId}|${baseRel}`;
    const now = Date.now();
    const cached = this.treeCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.nodes;
    }
    const nodes = await this.readDirectoryRecursive(baseDir, baseRel);
    this.treeCache.set(cacheKey, {
      expiresAt: now + ProjectFilesService.TREE_TTL_MS,
      nodes,
    });
    return nodes;
  }

  private async readDirectoryRecursive(
    absoluteDir: string,
    relativeDir: string,
  ): Promise<FileNode[]> {
    const entries: Dirent[] = await fsp.readdir(absoluteDir, {
      withFileTypes: true,
    });
    const result: FileNode[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (entry.isDirectory() && IGNORED_DIR_NAMES.has(name)) {
        continue;
      }
      const childRel = relativeDir ? `${relativeDir}/${name}` : name;
      const childAbs = join(absoluteDir, name);
      if (entry.isDirectory()) {
        const children = await this.readDirectoryRecursive(childAbs, childRel);
        result.push({ path: childRel, name, type: 'directory', children });
      } else if (entry.isFile()) {
        const stat = await fsp.stat(childAbs);
        result.push({ path: childRel, name, type: 'file', size: stat.size });
      }
    }
    return result;
  }

  async readFileContent(
    userId: string,
    projectId: string,
    relativePath: string,
  ): Promise<FileContentResponse> {
    if (!relativePath) {
      throw new BadRequestException('Query parameter "path" is required');
    }
    const rootDir = await this.getProjectRootDir(userId, projectId);
    const absolutePath = this.resolveAndValidatePath(rootDir, relativePath);
    const stat = await fsp.stat(absolutePath);
    if (!stat.isFile()) {
      throw new BadRequestException('Specified path is not a file');
    }
    const data = await fsp.readFile(absolutePath);
    const containsNull = data.includes(0);
    if (!containsNull && stat.size <= MAX_TEXT_FILE_BYTES) {
      const content = data.toString('utf-8');
      return {
        isBinary: false as const,
        content,
        encoding: 'utf-8',
        size: stat.size,
      };
    }
    // бинарный или слишком большой текст -> отдать как base64 при лимите 5MB
    const MAX_BINARY_BYTES = 5_000_000;
    if (stat.size > MAX_BINARY_BYTES) {
      throw new BadRequestException('Payload too large');
    }
    const lookupResult = mimeLookup(this.basename(relativePath));
    const mimeType =
      typeof lookupResult === 'string'
        ? lookupResult
        : 'application/octet-stream';
    return {
      isBinary: true as const,
      base64: data.toString('base64'),
      mimeType,
      size: stat.size,
    };
  }

  async writeFileContent(
    userId: string,
    projectId: string,
    relativePath: string,
    content: string,
  ): Promise<{ success: true; updatedAt: string }> {
    if (!relativePath) {
      throw new BadRequestException('Body field "path" is required');
    }
    const rootDir = await this.getProjectRootDir(userId, projectId);
    const absolutePath = this.resolveAndValidatePath(rootDir, relativePath);
    await ensureDirectoryExists(dirname(absolutePath));
    await fsp.writeFile(absolutePath, content, 'utf-8');
    this.invalidateTreeCache(projectId);
    const updatedAt = new Date().toISOString();
    return { success: true as const, updatedAt };
  }

  async createEntry(
    userId: string,
    projectId: string,
    body: CreateEntryBody,
  ): Promise<{ success: true; created: FileNode }> {
    const { path, type, content } = body;
    if (!path) {
      throw new BadRequestException('Field "path" is required');
    }
    if (type !== 'file' && type !== 'directory') {
      throw new BadRequestException(
        'Field "type" must be "file" or "directory"',
      );
    }
    const rootDir = await this.getProjectRootDir(userId, projectId);
    const absolutePath = this.resolveAndValidatePath(rootDir, path);
    if (type === 'directory') {
      await ensureDirectoryExists(absolutePath);
      this.invalidateTreeCache(projectId);
      return {
        success: true as const,
        created: { path, name: this.basename(path), type: 'directory' },
      };
    }
    // file
    await ensureDirectoryExists(dirname(absolutePath));
    await fsp.writeFile(absolutePath, content ?? '', 'utf-8');
    const stat = await fsp.stat(absolutePath);
    this.invalidateTreeCache(projectId);
    return {
      success: true as const,
      created: {
        path,
        name: this.basename(path),
        type: 'file',
        size: stat.size,
      },
    };
  }

  async deleteEntry(
    userId: string,
    projectId: string,
    relativePath: string,
  ): Promise<{ success: true }> {
    if (!relativePath) {
      throw new BadRequestException('Query parameter "path" is required');
    }
    const rootDir = await this.getProjectRootDir(userId, projectId);
    const absolutePath = this.resolveAndValidatePath(rootDir, relativePath);
    await fsp.rm(absolutePath, { recursive: true, force: true });
    this.invalidateTreeCache(projectId);
    return { success: true as const };
  }

  private basename(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  private invalidateTreeCache(projectId: string): void {
    for (const key of this.treeCache.keys()) {
      if (key.startsWith(projectId + '|')) {
        this.treeCache.delete(key);
      }
    }
  }
}
