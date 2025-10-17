import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma';
import type { Prisma, Project } from '../../generated/prisma';

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

  async createProject(args: Prisma.ProjectCreateArgs): Promise<Project> {
    return this.project.create(args);
  }

  async listProjectsByUser(userId: string): Promise<Project[]> {
    return this.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateProjectStatusByJobId(
    jobId: string,
    status: 'PROCESSING' | 'READY' | 'ERROR',
  ): Promise<Project | null> {
    try {
      return await this.project.update({
        where: { jobId },
        data: { status },
      });
    } catch (error) {
      // Если проект не найден по jobId, вернём null
      return null;
    }
  }

  async deleteProjectForUser(
    projectId: string,
    userId: string,
  ): Promise<Project | null> {
    const existing = await this.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!existing) return null;
    const deleted = await this.project.delete({ where: { id: projectId } });
    return deleted;
  }
}
