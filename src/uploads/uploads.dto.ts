import { ApiProperty } from '@nestjs/swagger';

export class UploadZipResponseDto {
  @ApiProperty({
    description: 'Идентификатор задания распаковки',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  jobId!: string;
}
