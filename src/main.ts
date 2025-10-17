import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Настройка graceful shutdown
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 8000;
  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}`);
  logger.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);

  // Обработка сигналов для graceful shutdown
  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.log(`📡 Received ${signal}. Starting graceful shutdown...`);

    try {
      await app.close();
      logger.log('✅ Application closed successfully');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during application shutdown:', error);
      process.exit(1);
    }
  };

  // Обработка различных сигналов
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGUSR2', () => void gracefulShutdown('SIGUSR2')); // nodemon restart

  // Обработка необработанных исключений
  process.on('uncaughtException', (error) => {
    logger.error('💥 Uncaught Exception:', error);
    void gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    void gracefulShutdown('unhandledRejection');
  });
}

void bootstrap();
