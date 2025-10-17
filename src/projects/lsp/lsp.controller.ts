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
import { LspGatewayService } from './gateway/lsp-gateway.service';
import { Request } from '@nestjs/common';

@ApiTags('lsp')
@Controller('projects/:projectId/lsp')
export class LspController {
  constructor(private readonly lspGateway: LspGatewayService) {}

  @Post('completion')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Получить автодополнения' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Список completion items' })
  async completion(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      path: string;
      position: { line: number; character: number };
      content?: string;
    },
  ) {
    return this.lspGateway.completion(req.user.id, projectId, body);
  }

  @Post('hover')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Информация при наведении' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Hover info' })
  async hover(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body()
    body: {
      path: string;
      position: { line: number; character: number };
      content?: string;
    },
  ) {
    return this.lspGateway.hover(req.user.id, projectId, body);
  }

  @Post('definition')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Переход к определению' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Definition locations' })
  async definition(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body()
    body: { path: string; position: { line: number; character: number } },
  ) {
    return this.lspGateway.definition(req.user.id, projectId, body);
  }
}
