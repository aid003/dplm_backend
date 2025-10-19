import { Injectable, Logger } from '@nestjs/common';
import { promises as fsp } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { isDevelopment, getLogLevel } from '../utils/environment.util';

export interface DependencyResult {
  filePath: string;
  dependencies: string[];
  dependents: string[];
}

@Injectable()
export class DependencyAnalyzerService {
  private readonly logger = new Logger(DependencyAnalyzerService.name);

  async findDependencies(
    projectPath: string,
    filePath: string,
    maxDepth: number = 2,
  ): Promise<string[]> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Анализируем зависимости для файла ${filePath}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры анализа зависимостей:', {
        projectPath,
        filePath,
        maxDepth,
      });
    }

    const visited = new Set<string>();
    const dependencies = new Set<string>();
    
    await this.findDependenciesRecursive(
      projectPath,
      filePath,
      dependencies,
      visited,
      0,
      maxDepth,
    );

    const result = Array.from(dependencies);
    const duration = Date.now() - startTime;

    this.logger.log(`Анализ зависимостей завершен за ${duration}ms: найдено ${result.length} зависимостей для ${filePath}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Результаты анализа зависимостей:', {
        filePath,
        dependencies: result,
        depth: maxDepth,
        duration,
      });
    }

    return result;
  }

  async analyzeProjectDependencies(
    projectPath: string,
    filePaths: string[],
    maxDepth: number = 1,
  ): Promise<Map<string, string[]>> {
    const logLevel = getLogLevel();
    const startTime = Date.now();

    this.logger.log(`Анализируем зависимости для ${filePaths.length} файлов`);

    const result = new Map<string, string[]>();

    for (const filePath of filePaths) {
      try {
        const dependencies = await this.findDependencies(
          projectPath,
          filePath,
          maxDepth,
        );
        result.set(filePath, dependencies);
      } catch (error) {
        this.logger.warn(`Ошибка при анализе зависимостей для ${filePath}:`, error);
        result.set(filePath, []);
      }
    }

    const duration = Date.now() - startTime;
    this.logger.log(`Анализ зависимостей проекта завершен за ${duration}ms`);

    if (logLevel === 'detailed') {
      this.logger.debug('Статистика анализа зависимостей:', {
        totalFiles: filePaths.length,
        totalDependencies: Array.from(result.values()).reduce((sum, deps) => sum + deps.length, 0),
        duration,
      });
    }

    return result;
  }

  private async findDependenciesRecursive(
    projectPath: string,
    filePath: string,
    dependencies: Set<string>,
    visited: Set<string>,
    currentDepth: number,
    maxDepth: number,
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(filePath)) {
      return;
    }

    visited.add(filePath);

    try {
      const fullPath = join(projectPath, filePath);
      const content = await fsp.readFile(fullPath, 'utf-8');
      const language = this.detectLanguage(filePath);

      const imports = this.extractImports(content, language, projectPath);
      
      for (const importPath of imports) {
        if (!dependencies.has(importPath)) {
          dependencies.add(importPath);
          
          // Рекурсивно ищем зависимости для найденного файла
          await this.findDependenciesRecursive(
            projectPath,
            importPath,
            dependencies,
            visited,
            currentDepth + 1,
            maxDepth,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`Не удалось проанализировать зависимости для ${filePath}:`, error);
    }
  }

  private extractImports(
    content: string,
    language: string,
    projectPath: string,
  ): string[] {
    const imports: string[] = [];

    switch (language) {
      case 'typescript':
      case 'javascript':
        imports.push(...this.extractJavaScriptImports(content, projectPath));
        break;
      case 'python':
        imports.push(...this.extractPythonImports(content, projectPath));
        break;
      case 'go':
        imports.push(...this.extractGoImports(content, projectPath));
        break;
    }

    return imports;
  }

  private extractJavaScriptImports(content: string, projectPath: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // ES6 imports
      const es6Match = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
      if (es6Match) {
        const importPath = es6Match[1];
        const resolvedPath = this.resolveJavaScriptImport(importPath, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
        continue;
      }

      // CommonJS require
      const requireMatch = trimmed.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (requireMatch) {
        const importPath = requireMatch[1];
        const resolvedPath = this.resolveJavaScriptImport(importPath, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
        continue;
      }

      // Dynamic imports
      const dynamicMatch = trimmed.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (dynamicMatch) {
        const importPath = dynamicMatch[1];
        const resolvedPath = this.resolveJavaScriptImport(importPath, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
      }
    }

    return imports;
  }

  private extractPythonImports(content: string, projectPath: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Standard imports
      const importMatch = trimmed.match(/^import\s+([a-zA-Z_][a-zA-Z0-9_.]*)/);
      if (importMatch) {
        const moduleName = importMatch[1];
        const resolvedPath = this.resolvePythonImport(moduleName, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
        continue;
      }

      // From imports
      const fromMatch = trimmed.match(/^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/);
      if (fromMatch) {
        const moduleName = fromMatch[1];
        const resolvedPath = this.resolvePythonImport(moduleName, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
      }
    }

    return imports;
  }

  private extractGoImports(content: string, projectPath: string): string[] {
    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      
      // Standard imports
      const importMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const importPath = importMatch[1];
        const resolvedPath = this.resolveGoImport(importPath, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
        continue;
      }

      // Import with alias
      const aliasMatch = trimmed.match(/^import\s+\w+\s+['"]([^'"]+)['"]/);
      if (aliasMatch) {
        const importPath = aliasMatch[1];
        const resolvedPath = this.resolveGoImport(importPath, projectPath);
        if (resolvedPath) {
          imports.push(resolvedPath);
        }
      }
    }

    return imports;
  }

  private resolveJavaScriptImport(importPath: string, projectPath: string): string | null {
    // Пропускаем внешние модули
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null;
    }

    // Относительные импорты
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      // Убираем расширение если есть
      let resolvedPath = importPath;
      if (resolvedPath.endsWith('.js') || resolvedPath.endsWith('.ts')) {
        resolvedPath = resolvedPath.slice(0, -3);
      }
      
      // Добавляем расширение обратно
      return resolvedPath + '.ts';
    }

    return null;
  }

  private resolvePythonImport(moduleName: string, projectPath: string): string | null {
    // Пропускаем стандартные модули Python
    const standardModules = [
      'os', 'sys', 'json', 'datetime', 'time', 'random', 'math', 're',
      'collections', 'itertools', 'functools', 'operator', 'pathlib',
      'typing', 'dataclasses', 'enum', 'abc', 'contextlib', 'logging',
    ];

    if (standardModules.includes(moduleName.split('.')[0])) {
      return null;
    }

    // Локальные модули
    const modulePath = moduleName.replace(/\./g, '/') + '.py';
    return modulePath;
  }

  private resolveGoImport(importPath: string, projectPath: string): string | null {
    // Пропускаем внешние модули
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null;
    }

    // Относительные импорты
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      return importPath + '.go';
    }

    return null;
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
      case '.go':
        return 'go';
      default:
        return 'unknown';
    }
  }
}
