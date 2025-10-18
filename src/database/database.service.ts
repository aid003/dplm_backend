import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma';
import type {
  Prisma,
  Project,
  AnalysisReport,
  Vulnerability,
  CodeExplanation,
} from '../../generated/prisma';

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
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error('❌ Failed to connect to database:', message);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      this.logger.log('🔌 Database connection closed gracefully');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error('❌ Error during database disconnection:', message);
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error('Database health check failed:', message);
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
    } catch {
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

  // Analysis Report methods
  async createAnalysisReport(
    data: Prisma.AnalysisReportCreateInput,
  ): Promise<AnalysisReport> {
    return this.analysisReport.create({ data });
  }

  async findAnalysisReportById(
    id: string,
  ): Promise<Prisma.AnalysisReportGetPayload<{
    include: { vulnerabilities: true; explanations: true };
  }> | null> {
    return this.analysisReport.findUnique({
      where: { id },
      include: {
        vulnerabilities: true,
        explanations: true,
      },
    });
  }

  async updateAnalysisReport(
    id: string,
    data: Prisma.AnalysisReportUpdateInput,
  ): Promise<AnalysisReport> {
    return this.analysisReport.update({
      where: { id },
      data,
    });
  }

  async listAnalysisReportsByProject(
    projectId: string,
    filters: Prisma.AnalysisReportWhereInput = {},
  ): Promise<
    Prisma.AnalysisReportGetPayload<{
      include: { vulnerabilities: true; explanations: true };
    }>[]
  > {
    return this.analysisReport.findMany({
      where: { projectId, ...filters },
      orderBy: { createdAt: 'desc' },
      include: {
        vulnerabilities: true,
        explanations: true,
      },
    });
  }

  async countAnalysisReports(
    where: Prisma.AnalysisReportWhereInput,
  ): Promise<number> {
    return this.analysisReport.count({ where });
  }

  // Vulnerability methods
  async createVulnerability(
    data: Prisma.VulnerabilityCreateInput,
  ): Promise<Vulnerability> {
    return this.vulnerability.create({ data });
  }

  async createManyVulnerabilities(
    data: Prisma.VulnerabilityCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return this.vulnerability.createMany({ data });
  }

  async findVulnerabilitiesByReport(
    reportId: string,
  ): Promise<Vulnerability[]> {
    return this.vulnerability.findMany({
      where: { reportId },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findVulnerabilitiesByProject(
    projectId: string,
    filters: Prisma.VulnerabilityWhereInput = {},
  ): Promise<Vulnerability[]> {
    return this.vulnerability.findMany({
      where: {
        report: {
          projectId,
          type: 'VULNERABILITY',
        },
        ...filters,
      },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    });
  }

  // Code Explanation methods
  async createCodeExplanation(
    data: Prisma.CodeExplanationCreateInput,
  ): Promise<CodeExplanation> {
    return this.codeExplanation.create({ data });
  }

  async createManyCodeExplanations(
    data: Prisma.CodeExplanationCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return this.codeExplanation.createMany({ data });
  }

  async findCodeExplanationsByReport(
    reportId: string,
  ): Promise<CodeExplanation[]> {
    return this.codeExplanation.findMany({
      where: { reportId },
      orderBy: [{ filePath: 'asc' }, { lineStart: 'asc' }],
    });
  }

  async findCodeExplanationsByProject(
    projectId: string,
    filters: Prisma.CodeExplanationWhereInput = {},
  ): Promise<CodeExplanation[]> {
    return this.codeExplanation.findMany({
      where: {
        report: {
          projectId,
          type: 'EXPLANATION',
        },
        ...filters,
      },
      orderBy: [{ filePath: 'asc' }, { lineStart: 'asc' }],
    });
  }
}
