import { Injectable, Logger } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';
import { CodeSymbol } from './openai.service';
import { isDevelopment, getLogLevel } from '../utils/environment.util';

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

  async parseFile(filePath: string, relativePath?: string): Promise<ParsedFile> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Парсим файл ${filePath}`);

    const language = this.detectLanguage(filePath);
    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let symbols: CodeSymbol[] = [];

    switch (language) {
      case 'typescript':
      case 'javascript':
        this.logger.log(`Парсим TypeScript/JavaScript файл ${filePath}`);
        symbols = this.parseTypeScriptFile(filePath, content);
        break;
      case 'python':
        this.logger.log(`Парсим Python файл ${filePath}`);
        symbols = this.parsePythonFile(filePath, content);
        break;
      case 'go':
        this.logger.log(`Парсим Go файл ${filePath}`);
        symbols = this.parseGoFile(filePath, content);
        break;
      default:
        this.logger.warn(
          `Неподдерживаемый язык: ${language} для файла ${filePath}`,
        );
    }

    const duration = Date.now() - startTime;
    this.logger.log(`Файл ${filePath} распарсен за ${duration}ms: найдено ${symbols.length} символов`);

    if (logLevel === 'detailed') {
      this.logger.debug('Детали парсинга файла:', {
        filePath,
        language,
        linesCount: lines.length,
        symbolsCount: symbols.length,
        symbolsByType: symbols.reduce((acc, s) => {
          acc[s.type] = (acc[s.type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        duration,
      });
    }

    return {
      filePath: relativePath || filePath,
      language,
      symbols,
      lines,
    };
  }

  async parseProject(
    projectPath: string,
    languages: string[] = ['typescript', 'javascript', 'python'],
  ): Promise<ParsedFile[]> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Парсим проект ${projectPath} для языков: ${languages.join(', ')}`);

    const files = await this.findSourceFiles(projectPath, languages);
    this.logger.log(`Найдено ${files.length} файлов для парсинга`);

    if (logLevel === 'detailed') {
      this.logger.debug('Файлы для парсинга:', {
        projectPath,
        languages,
        totalFiles: files.length,
        filesByLanguage: files.reduce((acc, file) => {
          const lang = this.detectLanguage(file);
          acc[lang] = (acc[lang] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      });
    }

    const results: ParsedFile[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const parsed = await this.parseFile(file);
        results.push(parsed);
        successCount++;
      } catch (error) {
        errorCount++;
        this.logger.warn(`Не удалось распарсить файл ${file}:`, error);
      }
    }

    const totalDuration = Date.now() - startTime;
    const totalSymbols = results.reduce((sum, f) => sum + f.symbols.length, 0);

    this.logger.log(`Парсинг проекта завершен за ${totalDuration}ms: успешно ${successCount} файлов, ошибок ${errorCount}, найдено ${totalSymbols} символов`);

    if (logLevel === 'detailed') {
      this.logger.debug('Статистика парсинга проекта:', {
        projectPath,
        totalFiles: files.length,
        successCount,
        errorCount,
        totalSymbols,
        filesByLanguage: results.reduce((acc, f) => {
          acc[f.language] = (acc[f.language] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
        symbolsByLanguage: results.reduce((acc, f) => {
          acc[f.language] = (acc[f.language] || 0) + f.symbols.length;
          return acc;
        }, {} as Record<string, number>),
        totalDuration,
      });
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

  private parseGoFile(filePath: string, content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split(/\r?\n/);

    // Регулярные выражения для поиска Go конструкций
    const patterns = [
      // Functions
      {
        regex: /^func\s+(\w+)\s*\([^)]*\)\s*(?:\w+\s+)?{/gm,
        type: 'function',
        nameIndex: 1,
      },
      // Methods
      {
        regex: /^func\s+\([^)]+\)\s+(\w+)\s*\([^)]*\)\s*(?:\w+\s+)?{/gm,
        type: 'method',
        nameIndex: 1,
      },
      // Structs
      {
        regex: /^type\s+(\w+)\s+struct\s*{/gm,
        type: 'class',
        nameIndex: 1,
      },
      // Interfaces
      {
        regex: /^type\s+(\w+)\s+interface\s*{/gm,
        type: 'interface',
        nameIndex: 1,
      },
      // Variables
      {
        regex: /^(?:var|const)\s+(\w+)\s*(?:=|:)/gm,
        type: 'variable',
        nameIndex: 1,
      },
      // Constants
      {
        regex: /^const\s+(\w+)\s*=/gm,
        type: 'variable',
        nameIndex: 1,
      },
      // Packages
      {
        regex: /^package\s+(\w+)/gm,
        type: 'type',
        nameIndex: 1,
      },
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const name = match[pattern.nameIndex];
        const lineNumber = content.substring(0, match.index).split('\n').length;
        const lineContent = lines[lineNumber - 1] || '';

        // Находим конец блока для функций, методов, структур и интерфейсов
        let endLine = lineNumber;
        if (['function', 'method', 'class', 'interface'].includes(pattern.type)) {
          endLine = this.findGoBlockEnd(content, match.index);
        }

        symbols.push({
          name,
          type: pattern.type as 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type',
          lineStart: lineNumber,
          lineEnd: endLine,
          code: lineContent,
          language: 'go',
        });
      }
    }

    return symbols;
  }

  private findGoBlockEnd(content: string, startIndex: number): number {
    const lines = content.split('\n');
    const startLine = content.substring(0, startIndex).split('\n').length;
    let braceCount = 0;
    let foundOpeningBrace = false;

    for (let i = startLine - 1; i < lines.length; i++) {
      const line = lines[i];
      
      for (const char of line) {
        if (char === '{') {
          braceCount++;
          foundOpeningBrace = true;
        } else if (char === '}') {
          braceCount--;
          if (foundOpeningBrace && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return startLine;
  }

  private calculateGoComplexity(code: string): number {
    let complexity = 1;

    // Подсчитываем условные конструкции
    const conditionalPatterns = [
      /\bif\s+/g,
      /\belse\s+/g,
      /\bfor\s+/g,
      /\brange\s+/g,
      /\bswitch\s+/g,
      /\bcase\s+/g,
      /\bdefault\s*:/g,
      /\bselect\s+/g,
      /\bgo\s+/g,
      /\bdefer\s+/g,
      /\bpanic\s*\(/g,
      /\brecover\s*\(/g,
    ];

    for (const pattern of conditionalPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        complexity += matches.length;
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
