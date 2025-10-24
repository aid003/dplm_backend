import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { VulnerabilityService } from './vulnerability/vulnerability.service';
import { ExplanationService } from './explanation/explanation.service';
import { RecommendationsService } from './recommendations/recommendations.service';
import { OpenAIService } from './explanation/openai.service';
import { AstParserService } from './explanation/ast-parser.service';
import { SemanticSearchService } from './explanation/semantic-search.service';
import { WeaviateService } from './explanation/weaviate.service';
import { DependencyAnalyzerService } from './explanation/dependency-analyzer.service';
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
    SemanticSearchService,
    WeaviateService,
    DependencyAnalyzerService,
    DatabaseService,
    ProjectsService,
  ],
  exports: [
    AnalysisService,
    VulnerabilityService,
    ExplanationService,
    RecommendationsService,
    SemanticSearchService,
    WeaviateService,
    DependencyAnalyzerService,
  ],
})
export class AnalysisModule {}
