import { Controller, Get, HttpStatus, HttpException } from '@nestjs/common';
import { AppService } from './app.service';
import { DatabaseService } from './database/database.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth(): Promise<{
    status: string;
    database: string;
    timestamp: string;
  }> {
    const isDbHealthy = await this.databaseService.isHealthy();

    if (!isDbHealthy) {
      throw new HttpException(
        {
          status: 'unhealthy',
          database: 'disconnected',
          timestamp: new Date().toISOString(),
          error: 'Database connection failed',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/detailed')
  async getDetailedHealth(): Promise<{
    status: string;
    services: {
      database: {
        status: string;
        responseTime?: number;
      };
    };
    timestamp: string;
    uptime: number;
  }> {
    const startTime = Date.now();
    const isDbHealthy = await this.databaseService.isHealthy();
    const dbResponseTime = Date.now() - startTime;

    const overallStatus = isDbHealthy ? 'healthy' : 'unhealthy';

    return {
      status: overallStatus,
      services: {
        database: {
          status: isDbHealthy ? 'connected' : 'disconnected',
          responseTime: isDbHealthy ? dbResponseTime : undefined,
        },
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
