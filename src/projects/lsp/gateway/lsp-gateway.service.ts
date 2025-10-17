import { Injectable, NotImplementedException } from '@nestjs/common';
import { extname } from 'node:path';
import { TypeScriptLspService } from '../typescript-lsp.service';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'yaml'
  | 'bash'
  | 'dockerfile'
  | 'python'
  | 'sql'
  | 'go'
  | 'rust'
  | 'java';

export interface CompletionBody {
  path: string;
  position: { line: number; character: number };
  content?: string;
}

export type HoverBody = CompletionBody;

export interface DefinitionBody {
  path: string;
  position: { line: number; character: number };
}

@Injectable()
export class LspGatewayService {
  constructor(private readonly tsLsp: TypeScriptLspService) {}

  private detectLanguage(filePath: string): SupportedLanguage | undefined {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.json':
        return 'json';
      case '.html':
        return 'html';
      case '.css':
        return 'css';
      case '.md':
      case '.markdown':
        return 'markdown';
      case '.yml':
      case '.yaml':
        return 'yaml';
      case '.sh':
        return 'bash';
      case '.dockerfile':
        return 'dockerfile';
      case '.py':
        return 'python';
      case '.sql':
        return 'sql';
      case '.go':
        return 'go';
      case '.rs':
        return 'rust';
      case '.java':
        return 'java';
      default:
        return undefined;
    }
  }

  private isSupportedByTsService(lang: SupportedLanguage): boolean {
    return lang === 'typescript' || lang === 'javascript' || lang === 'json';
  }

  async completion(
    userId: string,
    projectId: string,
    body: CompletionBody,
  ): Promise<{ items: unknown[] }> {
    const lang = this.detectLanguage(body.path);
    if (lang && this.isSupportedByTsService(lang)) {
      const info = await this.tsLsp.getCompletions(userId, projectId, body);
      return { items: info?.entries ?? [] };
    }
    throw new NotImplementedException(
      `LSP server for this language is not available: ${lang ?? 'unknown'}`,
    );
  }

  async hover(
    userId: string,
    projectId: string,
    body: HoverBody,
  ): Promise<{ contents: string[] }> {
    const lang = this.detectLanguage(body.path);
    if (lang && this.isSupportedByTsService(lang)) {
      const qi = await this.tsLsp.getHover(userId, projectId, body);
      const display = qi?.displayParts?.map((p) => p.text).join('') ?? '';
      return { contents: display ? [display] : [] };
    }
    throw new NotImplementedException(
      `LSP server for this language is not available: ${lang ?? 'unknown'}`,
    );
  }

  async definition(
    userId: string,
    projectId: string,
    body: DefinitionBody,
  ): Promise<{ locations: Array<{ path: string; textSpan?: unknown }> }> {
    const lang = this.detectLanguage(body.path);
    if (lang && this.isSupportedByTsService(lang)) {
      const defs = await this.tsLsp.getDefinition(userId, projectId, body);
      return {
        locations: (defs ?? []).map((d) => ({
          path: d.fileName,
          textSpan: d.textSpan,
        })),
      };
    }
    throw new NotImplementedException(
      `LSP server for this language is not available: ${lang ?? 'unknown'}`,
    );
  }
}
