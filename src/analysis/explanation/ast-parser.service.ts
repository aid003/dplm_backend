import { Injectable, Logger } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';
import { CodeSymbol } from './openai.service';

export interface ParsedFile {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  lines: string[];
}

export interface ComplexityMetrics {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  linesOfCode: number;
  commentLines: number;
}

@Injectable()
export class AstParserService {
  private readonly logger = new Logger(AstParserService.name);

  async parseFile(filePath: string): Promise<ParsedFile> {
    const language = this.detectLanguage(filePath);
    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let symbols: CodeSymbol[] = [];

    switch (language) {
      case 'typescript':
      case 'javascript':
        symbols = this.parseTypeScriptFile(filePath, content);
        break;
      case 'python':
        symbols = this.parsePythonFile(filePath, content);
        break;
      default:
        this.logger.warn(
          `Неподдерживаемый язык: ${language} для файла ${filePath}`,
        );
    }

    return {
      filePath,
      language,
      symbols,
      lines,
    };
  }

  async parseProject(
    projectPath: string,
    languages: string[] = ['typescript', 'javascript', 'python'],
  ): Promise<ParsedFile[]> {
    const files = await this.findSourceFiles(projectPath, languages);
    const results: ParsedFile[] = [];

    for (const file of files) {
      try {
        const parsed = await this.parseFile(file);
        results.push(parsed);
      } catch (error) {
        this.logger.warn(`Не удалось распарсить файл ${file}:`, error);
      }
    }

    return results;
  }

  calculateComplexity(symbol: CodeSymbol): ComplexityMetrics {
    const lines = symbol.code.split(/\r?\n/);
    const linesOfCode = lines.filter(
      (line) => line.trim() && !line.trim().startsWith('//'),
    ).length;
    const commentLines = lines.filter(
      (line) => line.trim().startsWith('//') || line.trim().startsWith('/*'),
    ).length;

    // Простой расчет цикломатической сложности
    const cyclomaticComplexity = this.calculateCyclomaticComplexity(
      symbol.code,
    );
    const cognitiveComplexity = this.calculateCognitiveComplexity(symbol.code);

    return {
      cyclomaticComplexity,
      cognitiveComplexity,
      linesOfCode,
      commentLines,
    };
  }

  private parseTypeScriptFile(filePath: string, content: string): CodeSymbol[] {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );

    const symbols: CodeSymbol[] = [];

    const visit = (node: ts.Node) => {
      // Функции
      if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push(this.createSymbol(node, 'function', sourceFile, content));
      }
      // Методы классов
      else if (ts.isMethodDeclaration(node) && node.name) {
        symbols.push(this.createSymbol(node, 'method', sourceFile, content));
      }
      // Классы
      else if (ts.isClassDeclaration(node) && node.name) {
        symbols.push(this.createSymbol(node, 'class', sourceFile, content));
      }
      // Интерфейсы
      else if (ts.isInterfaceDeclaration(node)) {
        symbols.push(this.createSymbol(node, 'interface', sourceFile, content));
      }
      // Type aliases
      else if (ts.isTypeAliasDeclaration(node)) {
        symbols.push(this.createSymbol(node, 'type', sourceFile, content));
      }
      // Переменные с функциями
      else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isFunctionExpression(node.initializer)
      ) {
        symbols.push(this.createSymbol(node, 'function', sourceFile, content));
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return symbols;
  }

  private parsePythonFile(_filePath: string, content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Функции
      if (line.startsWith('def ')) {
        const match = line.match(/def\s+(\w+)\s*\(/);
        if (match) {
          const name = match[1];
          const startLine = i + 1;
          const endLine = this.findPythonBlockEnd(lines, i);
          const code = lines.slice(i, endLine).join('\n');

          symbols.push({
            name,
            type: 'function',
            lineStart: startLine,
            lineEnd: endLine,
            code,
            language: 'python',
          });
        }
      }
      // Классы
      else if (line.startsWith('class ')) {
        const match = line.match(/class\s+(\w+)/);
        if (match) {
          const name = match[1];
          const startLine = i + 1;
          const endLine = this.findPythonBlockEnd(lines, i);
          const code = lines.slice(i, endLine).join('\n');

          symbols.push({
            name,
            type: 'class',
            lineStart: startLine,
            lineEnd: endLine,
            code,
            language: 'python',
          });
        }
      }
    }

    return symbols;
  }

  private createSymbol(
    node: ts.Node,
    type: CodeSymbol['type'],
    sourceFile: ts.SourceFile,
    content: string,
  ): CodeSymbol {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const name = this.getNodeName(node);

    const lines = content.split(/\r?\n/);
    const code = lines.slice(start.line, end.line + 1).join('\n');

    return {
      name: name || 'anonymous',
      type,
      lineStart: start.line + 1,
      lineEnd: end.line + 1,
      code,
      language: 'typescript',
    };
  }

  private getNodeName(node: ts.Node): string | undefined {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      return node.name?.getText();
    }
    if (ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
      return node.name?.getText();
    }
    return undefined;
  }

  private findPythonBlockEnd(lines: string[], startIndex: number): number {
    const indentLevel = this.getIndentLevel(lines[startIndex]);
    let i = startIndex + 1;

    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        i++;
        continue;
      }

      const currentIndent = this.getIndentLevel(line);
      if (currentIndent <= indentLevel) {
        break;
      }
      i++;
    }

    return i;
  }

  private getIndentLevel(line: string): number {
    return line.length - line.trimStart().length;
  }

  private calculateCyclomaticComplexity(code: string): number {
    let complexity = 1; // Базовая сложность

    // Подсчет условных операторов
    const conditionalPatterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bwhile\b/g,
      /\bfor\b/g,
      /\bswitch\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\?\s*[^:]*\s*:/g, // Тернарный оператор
      /\|\|/g, // OR оператор
      /&&/g, // AND оператор
    ];

    for (const pattern of conditionalPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.max(1, complexity);
  }

  private calculateCognitiveComplexity(code: string): number {
    // Упрощенный расчет когнитивной сложности
    let complexity = 0;

    const lines = code.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('if') ||
        trimmed.startsWith('while') ||
        trimmed.startsWith('for')
      ) {
        complexity += 1;
      }
      if (trimmed.includes('&&') || trimmed.includes('||')) {
        complexity += 1;
      }
      if (trimmed.includes('try') || trimmed.includes('catch')) {
        complexity += 1;
      }
    }

    return Math.max(1, complexity);
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
}
