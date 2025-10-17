import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../../generated/prisma';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { Request } from '@nestjs/common';
import prettier from 'prettier';
import { ProjectsService } from '../projects.service';
import { join } from 'node:path';
import { ensurePathInside } from '../../uploads/uploads.utils';

@ApiTags('format')
@Controller('projects/:projectId/format')
export class FormatController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Форматировать контент файла через Prettier' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Отформатированный контент' })
  async format(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body() body: { path: string; content: string },
  ): Promise<{ formatted: string }> {
    const project = await this.projectsService.findByIdForUser(
      req.user.id,
      projectId,
    );
    const abs = ensurePathInside(
      project.extractedPath,
      join(project.extractedPath, body.path),
    );
    const formatted = await prettier.format(body.content, { filepath: abs });
    return { formatted };
  }
}
