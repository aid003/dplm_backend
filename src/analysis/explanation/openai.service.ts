import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isDevelopment, getLogLevel } from '../utils/environment.util';

export interface CodeSymbol {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type';
  lineStart: number;
  lineEnd: number;
  code: string;
  language: string;
}

export interface ExplanationRequest {
  symbol: CodeSymbol;
  context?: string;
  includeComplexity?: boolean;
}

export interface ExplanationResponse {
  summary: string;
  detailed: string;
  complexity?: number;
}

export interface CohesiveExplanationRequest {
  userQuestion: string;
  relevantFiles: Array<{
    filePath: string;
    content: string;
    language: string;
  }>;
  targetFilePath?: string;
  targetSymbolName?: string;
}

export interface CohesiveExplanationResponse {
  explanation: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ParsedExplanationResponse {
  summary?: string;
  detailed?: string;
  complexity?: string | number;
}

@Injectable()
export class OpenAIService {
  private readonly logger = new Logger(OpenAIService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.openai.com/v1';

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('OPENAI_API_KEY') || '';
    if (!this.apiKey) {
      this.logger.warn('OPENAI_API_KEY не найден в переменных окружения');
    }
  }

  async explainCode(request: ExplanationRequest): Promise<ExplanationResponse> {
    if (!this.apiKey) {
      this.logger.error('OpenAI API key не настроен');
      throw new Error('OpenAI API key не настроен');
    }

    const startTime = Date.now();
    const logLevel = getLogLevel();

    this.logger.log(
      `Начинаем объяснение символа: ${request.symbol.name} (${request.symbol.type})`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Детали запроса:', {
        symbol: request.symbol,
        includeComplexity: request.includeComplexity,
        context: request.context,
      });
    }

    try {
      const prompt = this.buildPrompt(request);

      if (logLevel === 'detailed') {
        this.logger.debug('Сгенерированный промпт:', { prompt });
      }

      const response = await this.callOpenAI(prompt);
      const duration = Date.now() - startTime;

      this.logger.log(
        `Объяснение символа ${request.symbol.name} получено за ${duration}ms`,
      );

      if (logLevel === 'detailed') {
        this.logger.debug('Ответ от OpenAI:', { response });
      }

      return this.parseResponse(response);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при обращении к OpenAI API для символа ${request.symbol.name} (${duration}ms):`,
        error,
      );
      throw new Error(
        `Не удалось получить объяснение кода: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  async explainMultipleSymbols(
    symbols: CodeSymbol[],
  ): Promise<ExplanationResponse[]> {
    if (!this.apiKey) {
      this.logger.error('OpenAI API key не настроен');
      throw new Error('OpenAI API key не настроен');
    }

    const startTime = Date.now();
    const logLevel = getLogLevel();

    this.logger.log(`Начинаем объяснение ${symbols.length} символов`);

    if (logLevel === 'detailed') {
      this.logger.debug('Символы для объяснения:', {
        count: symbols.length,
        symbols: symbols.map((s) => ({
          name: s.name,
          type: s.type,
          language: s.language,
        })),
      });
    }

    try {
      const prompt = this.buildMultipleSymbolsPrompt(symbols);

      if (logLevel === 'detailed') {
        this.logger.debug(
          'Сгенерированный промпт для множественных символов:',
          { prompt },
        );
      }

      const response = await this.callOpenAI(prompt);
      const duration = Date.now() - startTime;

      this.logger.log(
        `Объяснения для ${symbols.length} символов получены за ${duration}ms`,
      );

      if (logLevel === 'detailed') {
        this.logger.debug('Ответ от OpenAI для множественных символов:', {
          response,
        });
      }

      return this.parseMultipleResponse(response, symbols.length);
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при обращении к OpenAI API для ${symbols.length} символов (${duration}ms):`,
        error,
      );
      throw new Error(
        `Не удалось получить объяснения кода: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  private buildPrompt(request: ExplanationRequest): string {
    const { symbol, context, includeComplexity } = request;

    let prompt = `Проанализируй следующий ${symbol.type} на языке ${symbol.language} и предоставь объяснение:

\`\`\`${symbol.language}
${symbol.code}
\`\`\`

`;

    if (context) {
      prompt += `Контекст: ${context}\n\n`;
    }

    prompt += `Пожалуйста, предоставь ответ в следующем JSON формате:
{
  "summary": "Краткое описание (1-2 предложения)",
  "detailed": "Подробное объяснение функциональности, параметров, возвращаемых значений и логики",
`;

    if (includeComplexity) {
      prompt += `  "complexity": "Цикломатическая сложность (число от 1 до 10)"`;
    }

    prompt += `
}

Объяснение должно быть на русском языке и содержать:
- Что делает этот код
- Какие параметры принимает (если применимо)
- Что возвращает (если применимо)
- Основную логику работы
- Потенциальные проблемы или улучшения`;

    return prompt;
  }

  private buildMultipleSymbolsPrompt(symbols: CodeSymbol[]): string {
    let prompt = `Проанализируй следующие символы кода и предоставь объяснения для каждого:

`;

    symbols.forEach((symbol, index) => {
      prompt += `${index + 1}. ${symbol.type} "${symbol.name}" (строки ${symbol.lineStart}-${symbol.lineEnd}):
\`\`\`${symbol.language}
${symbol.code}
\`\`\`

`;
    });

    prompt += `Пожалуйста, предоставь ответ в следующем JSON формате:
[
`;

    symbols.forEach((symbol, index) => {
      prompt += `  {
    "summary": "Краткое описание ${symbol.name}",
    "detailed": "Подробное объяснение ${symbol.name}",
    "complexity": "Цикломатическая сложность"
  }${index < symbols.length - 1 ? ',' : ''}
`;
    });

    prompt += `]

Объяснения должны быть на русском языке.`;

    return prompt;
  }

  private async callOpenAI(prompt: string): Promise<string> {
    const logLevel = getLogLevel();
    const requestStartTime = Date.now();

    const requestBody = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Ты эксперт по анализу кода. Твоя задача - объяснять код на русском языке в структурированном JSON формате. Всегда отвечай только валидным JSON без дополнительного текста.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    };

    if (logLevel === 'detailed') {
      this.logger.debug('Отправляем запрос к OpenAI API:', {
        model: requestBody.model,
        temperature: requestBody.temperature,
        max_tokens: requestBody.max_tokens,
        promptLength: prompt.length,
      });
    } else {
      this.logger.log(
        `Отправляем запрос к OpenAI API (модель: ${requestBody.model}, токены: ${requestBody.max_tokens})`,
      );
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const requestDuration = Date.now() - requestStartTime;

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(
        `OpenAI API error (${requestDuration}ms): ${response.status} ${errorText}`,
      );
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const responseContent = data.choices?.[0]?.message?.content || '';

    if (logLevel === 'detailed') {
      this.logger.debug('Получен ответ от OpenAI API:', {
        duration: requestDuration,
        responseLength: responseContent.length,
        usage: data.usage || 'неизвестно',
      });
    } else {
      this.logger.log(
        `Получен ответ от OpenAI API за ${requestDuration}ms (${responseContent.length} символов)`,
      );
    }

    return responseContent;
  }

  private parseResponse(response: string): ExplanationResponse {
    try {
      const parsed = JSON.parse(response) as ParsedExplanationResponse;
      return {
        summary: parsed.summary || 'Объяснение недоступно',
        detailed: parsed.detailed || 'Подробное объяснение недоступно',
        complexity: parsed.complexity
          ? parseInt(String(parsed.complexity))
          : undefined,
      };
    } catch {
      this.logger.warn(
        'Не удалось распарсить ответ, возвращаю базовое объяснение',
      );
      return {
        summary: 'Код требует анализа',
        detailed: response || 'Объяснение недоступно',
      };
    }
  }

  private parseMultipleResponse(
    response: string,
    expectedCount: number,
  ): ExplanationResponse[] {
    try {
      const parsed = JSON.parse(response) as ParsedExplanationResponse[];
      if (!Array.isArray(parsed)) {
        throw new Error('Ожидался массив ответов');
      }

      return parsed.map((item: ParsedExplanationResponse, index: number) => ({
        summary: item.summary || `Объяснение ${index + 1} недоступно`,
        detailed: item.detailed || 'Подробное объяснение недоступно',
        complexity: item.complexity
          ? parseInt(String(item.complexity))
          : undefined,
      }));
    } catch {
      this.logger.warn('Не удалось распарсить множественный ответ OpenAI');
      return Array(expectedCount)
        .fill(null)
        .map((_, index) => ({
          summary: `Объяснение ${index + 1} недоступно`,
          detailed: 'Объяснение недоступно',
        }));
    }
  }

  async createEmbedding(text: string): Promise<number[]> {
    if (!this.apiKey) {
      this.logger.error('OpenAI API key не настроен');
      throw new Error('OpenAI API key не настроен');
    }

    const startTime = Date.now();
    const logLevel = getLogLevel();

    this.logger.log(
      `Создаем embedding для текста длиной ${text.length} символов`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры создания embedding:', {
        textLength: text.length,
        textPreview: text.substring(0, 100) + '...',
      });
    }

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
        }),
      });

      const requestDuration = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `OpenAI Embeddings API error (${requestDuration}ms): ${response.status} ${errorText}`,
        );
        throw new Error(
          `OpenAI Embeddings API error: ${response.status} ${errorText}`,
        );
      }

      const data = await response.json();
      const embedding = data.data?.[0]?.embedding;

      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Неверный формат ответа от OpenAI Embeddings API');
      }

      if (logLevel === 'detailed') {
        this.logger.debug('Получен embedding от OpenAI API:', {
          duration: requestDuration,
          embeddingLength: embedding.length,
          firstValues: embedding.slice(0, 5),
        });
      } else {
        this.logger.log(
          `Embedding создан за ${requestDuration}ms (размер: ${embedding.length})`,
        );
      }

      return embedding;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при создании embedding (${duration}ms):`,
        error,
      );
      throw new Error(
        `Не удалось создать embedding: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  async generateFileSummary(
    filePath: string,
    content: string,
  ): Promise<string> {
    if (!this.apiKey) {
      this.logger.error('OpenAI API key не настроен');
      throw new Error('OpenAI API key не настроен');
    }

    const startTime = Date.now();
    const logLevel = getLogLevel();

    this.logger.log(`Генерируем краткое описание для файла ${filePath}`);

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры генерации описания:', {
        filePath,
        contentLength: content.length,
        contentPreview: content.substring(0, 200) + '...',
      });
    }

    try {
      const prompt = this.buildFileSummaryPrompt(filePath, content);

      if (logLevel === 'detailed') {
        this.logger.debug('Сгенерированный промпт для описания файла:', {
          prompt,
        });
      }

      const response = await this.callOpenAI(prompt);
      const duration = Date.now() - startTime;

      this.logger.log(
        `Описание файла ${filePath} сгенерировано за ${duration}ms`,
      );

      if (logLevel === 'detailed') {
        this.logger.debug('Ответ от OpenAI для описания файла:', { response });
      }

      return response.trim();
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при генерации описания файла ${filePath} (${duration}ms):`,
        error,
      );
      throw new Error(
        `Не удалось сгенерировать описание файла: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  calculateCosineSimilarity(
    embedding1: number[],
    embedding2: number[],
  ): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings должны иметь одинаковую размерность');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  private buildFileSummaryPrompt(filePath: string, content: string): string {
    const language = this.detectLanguageFromPath(filePath);
    const maxContentLength = 2000; // Ограничиваем размер контента для промпта
    const truncatedContent =
      content.length > maxContentLength
        ? content.substring(0, maxContentLength) + '\n... (файл обрезан)'
        : content;

    return `Проанализируй следующий файл кода и создай краткое описание его назначения и функциональности:

Путь к файлу: ${filePath}
Язык программирования: ${language}

Код:
\`\`\`${language}
${truncatedContent}
\`\`\`

Создай краткое описание (1-2 предложения) на русском языке, которое объясняет:
- Что делает этот файл
- Основную функциональность
- Ключевые компоненты или функции

Описание должно быть информативным и подходящим для семантического поиска.`;
  }

  private detectLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'typescript';
      case 'js':
      case 'jsx':
        return 'javascript';
      case 'py':
        return 'python';
      case 'java':
        return 'java';
      case 'go':
        return 'go';
      default:
        return 'text';
    }
  }

  async generateCohesiveExplanation(
    request: CohesiveExplanationRequest,
  ): Promise<CohesiveExplanationResponse> {
    if (!this.apiKey) {
      this.logger.error('OpenAI API key не настроен');
      throw new Error('OpenAI API key не настроен');
    }

    const startTime = Date.now();
    const logLevel = getLogLevel();

    this.logger.log(
      `Генерируем связное объяснение для ${request.relevantFiles.length} файлов`,
    );

    if (logLevel === 'detailed') {
      this.logger.debug('Параметры связного объяснения:', {
        userQuestion: request.userQuestion,
        targetFilePath: request.targetFilePath,
        targetSymbolName: request.targetSymbolName,
        filesCount: request.relevantFiles.length,
        files: request.relevantFiles.map((f) => ({
          filePath: f.filePath,
          language: f.language,
          contentLength: f.content.length,
        })),
      });
    }

    try {
      const prompt = this.buildCohesiveExplanationPrompt(request);

      if (logLevel === 'detailed') {
        this.logger.debug('Сгенерированный промпт для связного объяснения:', {
          prompt,
        });
      }

      const response = await this.callOpenAI(prompt);
      const duration = Date.now() - startTime;

      this.logger.log(`Связное объяснение сгенерировано за ${duration}ms`);

      if (logLevel === 'detailed') {
        this.logger.debug('Ответ от OpenAI для связного объяснения:', {
          response,
        });
      }

      return { explanation: response };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Ошибка при генерации связного объяснения (${duration}ms):`,
        error,
      );
      throw new Error(
        `Не удалось сгенерировать связное объяснение: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  private buildCohesiveExplanationPrompt(
    request: CohesiveExplanationRequest,
  ): string {
    let prompt = `Ты эксперт по анализу кода. Проанализируй предоставленные файлы и создай связное объяснение на русском языке.

Вопрос пользователя: "${request.userQuestion}"

ВАЖНО: Ты должен вернуть ТОЛЬКО markdown текст. НЕ используй JSON, НЕ используй поля "markdown", НЕ используй структуры данных. Начинай сразу с заголовка # и пиши обычный markdown текст.

`;

    if (request.targetFilePath && request.targetSymbolName) {
      prompt += `Целевой файл: ${request.targetFilePath}
Целевой символ: ${request.targetSymbolName}

`;
    }

    prompt += `Файлы для анализа:

`;

    // Адаптивное ограничение контента в зависимости от количества файлов
    const fileCount = request.relevantFiles.length;
    const baseLimit = 5000; // Базовый лимит 5000 символов
    const adaptiveLimit = Math.max(2000, Math.floor(20000 / fileCount)); // Адаптивное ограничение
    const maxContentLength = Math.min(baseLimit, adaptiveLimit);

    this.logger.log(
      `Адаптивное ограничение контента: ${maxContentLength} символов на файл (файлов: ${fileCount})`,
    );

    request.relevantFiles.forEach((file, index) => {
      const truncatedContent =
        file.content.length > maxContentLength
          ? file.content.substring(0, maxContentLength) + '\n... (файл обрезан)'
          : file.content;

      prompt += `${index + 1}. Файл: ${file.filePath}
Язык: ${file.language}

\`\`\`${file.language}
${truncatedContent}
\`\`\`

`;
    });

    prompt += `Создай объяснение в ТОЧНО таком markdown формате:

# [Заголовок объяснения системы]

[Краткое введение с использованием **жирного текста** для ключевых терминов и концепций]

## Основные файлы

1. **filename.ts** - описание назначения файла
2. **filename2.ts** - описание назначения файла
3. **filename3.ts** - описание назначения файла

## Как работает [название системы]

### Шаг 1: [Название первого шага]

[Объяснение с примерами кода]

\`\`\`typescript
// Пример кода с комментариями
function exampleFunction() {
  return result;
}
\`\`\`

### Шаг 2: [Название второго шага]

[Продолжение объяснения с кодом]

\`\`\`javascript
// Еще один пример кода
const example = {
  property: value
};
\`\`\`

### Шаг 3: [Название третьего шага]

[Завершающее объяснение]

\`\`\`python
# Пример на Python
def example_function():
    return result
\`\`\`

## Безопасность

- Пароли хешируются с помощью **bcrypt**
- Токены имеют ограниченное время жизни
- Секретные ключи хранятся в переменных окружения

## Зависимости

Система использует следующие npm пакеты:
- \`package-name\` для описания назначения
- \`another-package\` для описания назначения
- \`third-package\` для описания назначения

**ОБЯЗАТЕЛЬНЫЕ ТРЕБОВАНИЯ К ФОРМАТИРОВАНИЮ:**

1. **Заголовки:** Используй # для главного заголовка, ## для разделов, ### для подразделов
2. **Код:** Всегда указывай язык в блоках \`\`\`language
3. **Жирный текст:** Используй **текст** для выделения ключевых терминов
4. **Списки:** Нумерованные списки (1., 2., 3.) для шагов, маркированные (-) для перечислений
5. **Структура:** Строго следуй указанной структуре с разделами "Основные файлы", "Как работает", "Безопасность", "Зависимости"
6. **Примеры кода:** Включай релевантные фрагменты кода с правильными языковыми тегами
7. **Объяснения:** Пиши простым языком, объясняй что делает каждый компонент

**КРИТИЧЕСКИ ВАЖНО:** 
- НЕ возвращай JSON
- НЕ используй поля типа "markdown" 
- НЕ создавай структуры данных
- Возвращай ТОЛЬКО чистый markdown текст
- Начинай сразу с символа # (заголовок)
- Заканчивай последним разделом
- Пиши как обычный markdown документ

Пример правильного ответа:
# Название системы
**Введение** - описание системы

## Основные файлы
1. **file.ts** - описание

## Как работает система
### Шаг 1: Название
Объяснение с кодом:
\`\`\`typescript
// код
\`\`\`

## Безопасность
- пункт 1
- пункт 2

## Зависимости
- \`package\` - описание`;

    return prompt;
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }
}
