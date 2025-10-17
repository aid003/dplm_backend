import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request as ExpressRequest } from 'express';
import type { User } from '../../../generated/prisma';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { DiagnosticsService, DiagnosticItem } from './diagnostics.service';
import { Request } from '@nestjs/common';

@ApiTags('diagnostics')
@Controller('projects/:projectId/diagnostics')
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Получить TS-диагностику проекта или файла' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'path', required: false })
  @ApiOkResponse({ description: 'Список диагностик' })
  async list(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Query('path') path?: string,
  ): Promise<{ diagnostics: DiagnosticItem[] }> {
    const diags = await this.diagnostics.getTypeScriptDiagnostics(
      req.user.id,
      projectId,
      path,
    );
    return { diagnostics: diags };
  }
}
