import { Injectable, Logger } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import { Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';
import { ProjectsService } from '../projects.service';
import { ensurePathInside } from '../../uploads/uploads.utils';

export interface CompletionParams {
  path: string;
  position: { line: number; character: number };
  content?: string;
}

export interface HoverParams {
  path: string;
  position: { line: number; character: number };
  content?: string;
}

export interface DefinitionParams {
  path: string;
  position: { line: number; character: number };
}

interface ProjectLanguageService {
  service: ts.LanguageService;
  getScriptVersion: (fileName: string) => string;
  updateFile: (fileName: string, content: string) => void;
}

const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
]);

@Injectable()
export class TypeScriptLspService {
  private readonly logger = new Logger(TypeScriptLspService.name);
  private readonly lsByProjectId = new Map<string, ProjectLanguageService>();

  constructor(private readonly projectsService: ProjectsService) {}

  private async getRootDir(userId: string, projectId: string): Promise<string> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    return project.extractedPath;
  }

  private async enumerateProjectFiles(rootDir: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(absDir: string): Promise<void> {
      const entries: Dirent[] = await fsp.readdir(absDir, {
        withFileTypes: true,
      });
      for (const e of entries) {
        if (e.isDirectory()) {
          if (IGNORED_DIR_NAMES.has(e.name)) continue;
          await walk(join(absDir, e.name));
        } else if (e.isFile()) {
          const file = join(absDir, e.name);
          const ext = extname(file).toLowerCase();
          if (
            ext === '.ts' ||
            ext === '.tsx' ||
            ext === '.js' ||
            ext === '.jsx' ||
            ext === '.json'
          ) {
            out.push(file);
          }
        }
      }
    }
    await walk(rootDir);
    return out;
  }

  private async createLanguageService(
    rootDir: string,
  ): Promise<ProjectLanguageService> {
    const files = new Map<string, { version: number; content?: string }>();
    const fileNames = await this.enumerateProjectFiles(rootDir);
    for (const f of fileNames) files.set(f, { version: 0 });

    const compilerOptions: ts.CompilerOptions = {
      allowJs: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true,
      strict: true,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      types: [],
    };

    const servicesHost: ts.LanguageServiceHost = {
      getScriptFileNames: () => Array.from(files.keys()),
      getScriptVersion: (fileName: string) =>
        String(files.get(fileName)?.version ?? 0),
      getScriptSnapshot: (fileName: string) => {
        try {
          const meta = files.get(fileName);
          if (!meta) return undefined;
          if (typeof meta.content === 'string') {
            return ts.ScriptSnapshot.fromString(meta.content);
          }
          const text = ts.sys.readFile(fileName);
          if (typeof text === 'string')
            return ts.ScriptSnapshot.fromString(text);
          return undefined;
        } catch {
          return undefined;
        }
      },
      getCurrentDirectory: () => rootDir,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (p) => ts.sys.fileExists(p),
      readFile: (p) => ts.sys.readFile(p),
      readDirectory: (p, ext, ex, inc) => ts.sys.readDirectory(p, ext, ex, inc),
      directoryExists: (p) => ts.sys.directoryExists(p),
      getDirectories: (p) => ts.sys.getDirectories(p),
    };

    const service = ts.createLanguageService(
      servicesHost,
      ts.createDocumentRegistry(),
    );
    return {
      service,
      getScriptVersion: (f: string) => String(files.get(f)?.version ?? 0),
      updateFile: (f: string, content: string) => {
        if (!files.has(f)) files.set(f, { version: 0 });
        const meta = files.get(f)!;
        meta.version++;
        meta.content = content;
      },
    };
  }

  private async getOrCreateLs(
    userId: string,
    projectId: string,
  ): Promise<ProjectLanguageService> {
    const key = projectId;
    const existing = this.lsByProjectId.get(key);
    if (existing) return existing;
    const rootDir = await this.getRootDir(userId, projectId);
    const ls = await this.createLanguageService(rootDir);
    this.lsByProjectId.set(key, ls);
    return ls;
  }

  async getCompletions(
    userId: string,
    projectId: string,
    params: CompletionParams,
  ): Promise<ts.CompletionInfo | undefined> {
    const rootDir = await this.getRootDir(userId, projectId);
    const abs = ensurePathInside(rootDir, join(rootDir, params.path));
    const ls = await this.getOrCreateLs(userId, projectId);
    if (typeof params.content === 'string') {
      ls.updateFile(abs, params.content);
    }
    const offset = this.positionToOffset(abs, params.position);
    return ls.service.getCompletionsAtPosition(abs, offset, {});
  }

  async getHover(
    userId: string,
    projectId: string,
    params: HoverParams,
  ): Promise<ts.QuickInfo | undefined> {
    const rootDir = await this.getRootDir(userId, projectId);
    const abs = ensurePathInside(rootDir, join(rootDir, params.path));
    const ls = await this.getOrCreateLs(userId, projectId);
    if (typeof params.content === 'string') {
      ls.updateFile(abs, params.content);
    }
    const offset = this.positionToOffset(abs, params.position);
    return ls.service.getQuickInfoAtPosition(abs, offset);
  }

  async getDefinition(
    userId: string,
    projectId: string,
    params: DefinitionParams,
  ): Promise<readonly ts.DefinitionInfo[] | undefined> {
    const rootDir = await this.getRootDir(userId, projectId);
    const abs = ensurePathInside(rootDir, join(rootDir, params.path));
    const ls = await this.getOrCreateLs(userId, projectId);
    const offset = this.positionToOffset(abs, params.position);
    return ls.service.getDefinitionAtPosition(abs, offset);
  }

  private positionToOffset(
    filePath: string,
    pos: { line: number; character: number },
  ): number {
    const text = ts.sys.readFile(filePath) ?? '';
    let offset = 0;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < pos.line; i++) {
      offset += lines[i]?.length ?? 0;
      offset += 1; // newline
    }
    offset += pos.character;
    return offset;
  }
}
