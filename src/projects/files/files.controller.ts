import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Query,
  Body,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiParam,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../../generated/prisma';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { ProjectFilesService } from './files.service';
import type {
  FileNode,
  FileContentResponse,
  CreateEntryBody,
} from './files.service';
import { Request } from '@nestjs/common';

@ApiTags('project-files')
@Controller('projects/:projectId/files')
export class ProjectFilesController {
  constructor(private readonly filesService: ProjectFilesService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary:
      'Получить дерево файлов. Lazy: по query path — содержимое директории',
  })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'path',
    required: false,
    description: 'Относительный путь директории',
  })
  @ApiOkResponse({ description: 'Список узлов файловой системы' })
  async getTree(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Query('path') path?: string,
  ): Promise<FileNode[]> {
    return this.filesService.getFileTree(req.user.id, projectId, path);
  }

  @Get('content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Получить содержимое файла' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'path',
    required: true,
    description: 'Относительный путь файла',
  })
  @ApiOkResponse({ description: 'Содержимое файла' })
  async getContent(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Query('path') filePath: string,
  ): Promise<FileContentResponse> {
    return this.filesService.readFileContent(req.user.id, projectId, filePath);
  }

  @Put('content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Сохранить изменения файла' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Файл сохранён' })
  async putContent(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body() body: { path?: string; content?: string },
  ): Promise<{ success: true; updatedAt: string }> {
    if (!body?.path) throw new BadRequestException('path is required');
    return this.filesService.writeFileContent(
      req.user.id,
      projectId,
      body.path,
      body.content ?? '',
    );
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Создать новый файл или папку' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Созданный узел' })
  async createEntry(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body() body: CreateEntryBody,
  ): Promise<{ success: true; created: FileNode }> {
    return this.filesService.createEntry(req.user.id, projectId, body);
  }

  @Delete()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Удалить файл или папку' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'path', required: true, description: 'Относительный путь' })
  @ApiOkResponse({ description: 'Удалено' })
  async deleteEntry(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Query('path') path: string,
  ): Promise<{ success: true }> {
    return this.filesService.deleteEntry(req.user.id, projectId, path);
  }
}
