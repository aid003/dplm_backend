import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma';

@Injectable()
export class DatabaseService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? [{ emit: 'stdout', level: 'query' }]
          : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('✅ Database connection established successfully');
    } catch (error) {
      this.logger.error(
        '❌ Failed to connect to database:',
        error instanceof Error ? error.message : String(error),
      );
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      this.logger.log('🔌 Database connection closed gracefully');
    } catch (error) {
      this.logger.error(
        '❌ Error during database disconnection:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        'Database health check failed:',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}
