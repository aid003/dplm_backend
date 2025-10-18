import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { VulnerabilityService } from './vulnerability/vulnerability.service';
import { ExplanationService } from './explanation/explanation.service';
import { RecommendationsService } from './recommendations/recommendations.service';
import { OpenAIService } from './explanation/openai.service';
import { AstParserService } from './explanation/ast-parser.service';
import { DatabaseService } from '../database/database.service';
import { ProjectsService } from '../projects/projects.service';

@Module({
  imports: [ConfigModule],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    VulnerabilityService,
    ExplanationService,
    RecommendationsService,
    OpenAIService,
    AstParserService,
    DatabaseService,
    ProjectsService,
  ],
  exports: [
    AnalysisService,
    VulnerabilityService,
    ExplanationService,
    RecommendationsService,
  ],
})
export class AnalysisModule {}
