import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  Sse,
  Param,
  MessageEvent,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UploadZipResponseDto } from './uploads.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { UploadsService } from './uploads.service';
import type { ProgressEvent } from './uploads.types';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('zip')
  @ApiOperation({ summary: 'Загрузка ZIP файла и запуск распаковки' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
      required: ['file'],
    },
  })
  @ApiOkResponse({ type: UploadZipResponseDto })
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
        if (lower.endsWith('.zip')) cb(null, true);
        else
          cb(
            new BadRequestException(
              'Only .zip files are allowed',
            ) as unknown as Error,
            false,
          );
      },
    }),
  )
  async uploadZip(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<UploadZipResponseDto> {
    if (!file) throw new BadRequestException('No file provided');
    await this.uploadsService.validateZipSignature(file.path);

    const jobId = randomUUID();
    const targetDir = join(
      this.uploadsService.getStorageConfig().extractedDir,
      jobId,
    );
    // fire and forget
    void this.uploadsService.startExtraction(jobId, file.path, targetDir);
    return { jobId };
  }

  @Sse('progress/:jobId')
  progress(
    @Param('jobId') jobId: string,
  ): Observable<MessageEvent | { data: ProgressEvent }> {
    const subject = this.uploadsService.getOrCreateSubject(jobId);
    return new Observable((subscriber) => {
      const sub = subject.subscribe({
        next: (event) => subscriber.next({ data: event }),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      return () => sub.unsubscribe();
    });
  }
}
