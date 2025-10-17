import { Injectable, BadRequestException } from '@nestjs/common';
import { ProjectsService } from '../projects.service';
import { join } from 'node:path';
import ts from 'typescript';
import { ensurePathInside } from '../../uploads/uploads.utils';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticItem {
  path: string;
  severity: DiagnosticSeverity;
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  code?: string | number;
  source?: string;
}

@Injectable()
export class DiagnosticsService {
  constructor(private readonly projectsService: ProjectsService) {}

  private async getRootDir(userId: string, projectId: string): Promise<string> {
    const project = await this.projectsService.findByIdForUser(
      userId,
      projectId,
    );
    return project.extractedPath;
  }

  async getTypeScriptDiagnostics(
    userId: string,
    projectId: string,
    filePath?: string,
  ): Promise<DiagnosticItem[]> {
    const rootDir = await this.getRootDir(userId, projectId);
    const configPath = ts.findConfigFile(
      rootDir,
      (p) => ts.sys.fileExists(p),
      'tsconfig.json',
    );
    const config = configPath
      ? ts.readConfigFile(configPath, (p) => ts.sys.readFile(p))
      : { config: { compilerOptions: { allowJs: true } } };
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      rootDir,
      undefined,
      configPath ?? 'tsconfig.json',
    );
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });

    const toReport: ts.Diagnostic[] = [];
    if (filePath) {
      const abs = ensurePathInside(rootDir, join(rootDir, filePath));
      const sf = program.getSourceFile(abs);
      if (!sf) throw new BadRequestException('File not part of the program');
      toReport.push(...program.getSyntacticDiagnostics(sf));
      toReport.push(...program.getSemanticDiagnostics(sf));
    } else {
      toReport.push(...program.getSyntacticDiagnostics());
      toReport.push(...program.getSemanticDiagnostics());
    }

    return toReport.map((d) => this.tsDiagToItem(d, rootDir));
  }

  private tsDiagToItem(d: ts.Diagnostic, rootDir: string): DiagnosticItem {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const file = d.file?.fileName ?? '';
    let startLine = 0;
    let startChar = 0;
    let endLine = 0;
    let endChar = 0;
    if (d.file && typeof d.start === 'number' && typeof d.length === 'number') {
      const startPos = d.file.getLineAndCharacterOfPosition(d.start);
      const endPos = d.file.getLineAndCharacterOfPosition(d.start + d.length);
      startLine = startPos.line;
      startChar = startPos.character;
      endLine = endPos.line;
      endChar = endPos.character;
    }
    const severity: DiagnosticSeverity =
      d.category === ts.DiagnosticCategory.Error
        ? 'error'
        : d.category === ts.DiagnosticCategory.Warning
          ? 'warning'
          : 'info';
    return {
      path: file.startsWith(rootDir + '/')
        ? file.slice(rootDir.length + 1)
        : file,
      severity,
      message,
      range: {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
      },
      code: d.code,
      source: 'typescript',
    };
  }
}
