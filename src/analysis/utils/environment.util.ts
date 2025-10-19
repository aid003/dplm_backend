/**
 * Утилиты для работы с окружением
 */

export const isDevelopment = (): boolean => {
  return process.env.NODE_ENV === 'development';
};

export const isProduction = (): boolean => {
  return process.env.NODE_ENV === 'production';
};

export const getLogLevel = (): 'detailed' | 'basic' => {
  return isDevelopment() ? 'detailed' : 'basic';
};

/**
 * Утилиты для работы с отчетами анализа
 */
export class AnalysisCancellationError extends Error {
  constructor(reportId: string) {
    super(`Analysis ${reportId} was cancelled`);
    this.name = 'AnalysisCancellationError';
  }
}
