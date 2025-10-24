import { Module } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MulterModule } from '@nestjs/platform-express';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    MulterModule.register({
      limits: {
        fileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
    }),
    AnalysisModule,
  ],
  controllers: [UploadsController],
  providers: [UploadsService, DatabaseService],
  exports: [UploadsService],
})
export class UploadsModule {}
