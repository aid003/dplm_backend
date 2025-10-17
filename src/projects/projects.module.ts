import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { UploadsModule } from '../uploads/uploads.module';
import { DatabaseService } from '../database/database.service';
import { ProjectFilesController } from './files/files.controller';
import { ProjectFilesService } from './files/files.service';
import { TypeScriptLspService } from './lsp/typescript-lsp.service';
import { LspGatewayService } from './lsp/gateway/lsp-gateway.service';
import { LspController } from './lsp/lsp.controller';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { DiagnosticsController } from './diagnostics/diagnostics.controller';
import { FormatController } from './diagnostics/format.controller';
import { SearchController } from './search/search.controller';

@Module({
  imports: [
    UploadsModule,
    MulterModule.register({
      limits: {
        fileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
    }),
  ],
  controllers: [
    ProjectsController,
    ProjectFilesController,
    LspController,
    DiagnosticsController,
    FormatController,
    SearchController,
  ],
  providers: [
    ProjectsService,
    ProjectFilesService,
    TypeScriptLspService,
    LspGatewayService,
    DiagnosticsService,
    DatabaseService,
  ],
})
export class ProjectsModule {}
