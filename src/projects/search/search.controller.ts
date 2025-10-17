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
import { ProjectsService } from '../projects.service';
import { ensurePathInside } from '../../uploads/uploads.utils';
import { spawn } from 'node:child_process';

interface SearchBody {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  includePattern?: string;
  excludePattern?: string;
}

@ApiTags('search')
@Controller('projects/:projectId/search')
export class SearchController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Полнотекстовый поиск по проекту (ripgrep)' })
  @ApiParam({ name: 'projectId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ description: 'Результаты поиска' })
  async search(
    @Request() req: ExpressRequest & { user: Omit<User, 'passwordHash'> },
    @Param('projectId') projectId: string,
    @Body() body: SearchBody,
  ): Promise<{
    matches: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      preview: string;
    }>;
    total: number;
  }> {
    const project = await this.projectsService.findByIdForUser(
      req.user.id,
      projectId,
    );
    const root = project.extractedPath;
    ensurePathInside(root, root); // sanity

    const args: string[] = ['--line-number', '--column', '--color=never'];
    if (!body.regex) args.push('--fixed-strings');
    if (!body.caseSensitive) args.push('--ignore-case');
    if (body.includePattern) args.push('--glob', body.includePattern);
    if (body.excludePattern) args.push('--glob', `!${body.excludePattern}`);
    args.push(body.query, '.');

    const results: Array<{
      path: string;
      line: number;
      column: number;
      text: string;
      preview: string;
    }> = [];
    const total = await new Promise<number>((resolvePromise, reject) => {
      const rg = spawn('rg', args, { cwd: root });
      let count = 0;
      const previewBuffer: string[] = [];
      rg.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf-8').split(/\r?\n/);
        for (const line of lines) {
          if (!line) continue;
          // format: file:line:column:text
          const firstColon = line.indexOf(':');
          const secondColon =
            firstColon >= 0 ? line.indexOf(':', firstColon + 1) : -1;
          const thirdColon =
            secondColon >= 0 ? line.indexOf(':', secondColon + 1) : -1;
          if (firstColon < 0 || secondColon < 0 || thirdColon < 0) continue;
          const file = line.slice(0, firstColon);
          const ln = Number(line.slice(firstColon + 1, secondColon));
          const col = Number(line.slice(secondColon + 1, thirdColon));
          const text = line.slice(thirdColon + 1);
          previewBuffer.push(text);
          const preview = previewBuffer.slice(-3).join('\n');
          results.push({ path: file, line: ln, column: col, text, preview });
          count++;
        }
      });
      rg.stderr.on('data', () => {});
      rg.on('error', reject);
      rg.on('close', () => resolvePromise(count));
    });

    return { matches: results, total };
  }
}
