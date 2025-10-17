import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Project, $Enums, Prisma } from '../../generated/prisma';

type ProjectStatusType = $Enums.ProjectStatus;

@Injectable()
export class ProjectsService {
  constructor(private readonly databaseService: DatabaseService) {}

  create(data: {
    userId: string;
    name: string;
    description?: string;
    zipPath: string;
    extractedPath: string;
    jobId: string;
    status: ProjectStatusType;
  }): Promise<Project> {
    const args: Prisma.ProjectCreateArgs = {
      data: {
        userId: data.userId,
        name: data.name,
        description: data.description,
        zipPath: data.zipPath,
        extractedPath: data.extractedPath,
        jobId: data.jobId,
        status: data.status,
      },
    };
    return this.databaseService.createProject(args);
  }

  listByUser(userId: string): Promise<Project[]> {
    return this.databaseService.listProjectsByUser(userId);
  }

  async removeById(userId: string, projectId: string): Promise<Project> {
    const deleted = await this.databaseService.deleteProjectForUser(
      projectId,
      userId,
    );
    if (!deleted) {
      throw new NotFoundException('Project not found');
    }
    return deleted;
  }
}
