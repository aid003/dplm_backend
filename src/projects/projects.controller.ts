import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
  Request,
  Delete,
  Param,
  HttpCode,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiNoContentResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../generated/prisma';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UploadsService } from '../uploads/uploads.service';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectDto } from './dto/project.dto';
import type { Project } from '../../generated/prisma';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly uploadsService: UploadsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Создать проект, загрузив ZIP одним запросом' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
      required: ['name', 'file'],
    },
  })
  @ApiOkResponse({ type: ProjectDto })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, 'storage/uploads'),
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}-${randomUUID()}`;
          const ext = extname(file.originalname) || '.zip';
          cb(null, `${unique}${ext}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const lower = file.originalname.toLowerCase();
        if (lower.endsWith('.zip')) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      },
    }),
  )
  async create(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CreateProjectDto,
  ): Promise<ProjectDto> {
    if (!file) throw new BadRequestException('No file provided');
    if (!body?.name) throw new BadRequestException('Name is required');

    await this.uploadsService.validateZipSignature(file.path);

    const jobId = randomUUID();
    const targetDir = join(
      this.uploadsService.getStorageConfig().extractedDir,
      jobId,
    );

    // fire and forget extraction
    void this.uploadsService.startExtraction(jobId, file.path, targetDir);

    const created: Project = await this.projectsService.create({
      userId: req.user.id,
      name: body.name,
      description: body.description,
      zipPath: file.path,
      extractedPath: targetDir,
      jobId,
      status: 'PROCESSING',
    });

    const dto: ProjectDto = {
      id: created.id,
      name: created.name,
      description: created.description,
      zipPath: created.zipPath,
      extractedPath: created.extractedPath,
      jobId: created.jobId,
      status: created.status,
      userId: created.userId,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
    return dto;
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Список проектов текущего пользователя' })
  @ApiOkResponse({ type: [ProjectDto] })
  async listMine(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
  ): Promise<ProjectDto[]> {
    const list: Project[] = await this.projectsService.listByUser(req.user.id);
    const dto: ProjectDto[] = list.map((p: Project) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      zipPath: p.zipPath,
      extractedPath: p.extractedPath,
      jobId: p.jobId,
      status: p.status,
      userId: p.userId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
    return dto;
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Удалить проект текущего пользователя' })
  @ApiParam({
    name: 'id',
    description: 'ID проекта',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiNoContentResponse({ description: 'Проект удалён' })
  @ApiNotFoundResponse({ description: 'Проект не найден' })
  @HttpCode(204)
  async remove(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const deleted = await this.projectsService.removeById(req.user.id, id);
    await this.uploadsService.removeProjectArtifacts(
      deleted.zipPath,
      deleted.extractedPath,
    );
  }
}
