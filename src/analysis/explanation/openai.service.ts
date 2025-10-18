import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
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
      throw new Error('OpenAI API key не настроен');
    }

    try {
      const prompt = this.buildPrompt(request);
      const response = await this.callOpenAI(prompt);

      return this.parseResponse(response);
    } catch (error) {
      this.logger.error('Ошибка при обращении к OpenAI API:', error);
      throw new Error(
        `Не удалось получить объяснение кода: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`,
      );
    }
  }

  async explainMultipleSymbols(
    symbols: CodeSymbol[],
  ): Promise<ExplanationResponse[]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key не настроен');
    }

    try {
      const prompt = this.buildMultipleSymbolsPrompt(symbols);
      const response = await this.callOpenAI(prompt);

      return this.parseMultipleResponse(response, symbols.length);
    } catch (error) {
      this.logger.error(
        'Ошибка при обращении к OpenAI API для множественных символов:',
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    return data.choices?.[0]?.message?.content || '';
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
        'Не удалось распарсить ответ OpenAI, возвращаю базовое объяснение',
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

  isAvailable(): boolean {
    return !!this.apiKey;
  }
}
