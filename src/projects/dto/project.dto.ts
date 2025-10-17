import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProjectDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional()
  description: string | null;

  @ApiProperty()
  zipPath: string;

  @ApiProperty()
  extractedPath: string;

  @ApiProperty()
  jobId: string;

  @ApiProperty({ enum: ['PROCESSING', 'READY', 'ERROR'] })
  status: 'PROCESSING' | 'READY' | 'ERROR';

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
