import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { UploadsModule } from '../uploads/uploads.module';
import { DatabaseService } from '../database/database.service';

@Module({
  imports: [
    UploadsModule,
    MulterModule.register({
      limits: {
        fileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
    }),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, DatabaseService],
})
export class ProjectsModule {}
