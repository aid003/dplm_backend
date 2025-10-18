-- CreateEnum
CREATE TYPE "AnalysisType" AS ENUM ('VULNERABILITY', 'EXPLANATION', 'RECOMMENDATION', 'FULL');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VulnSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateTable
CREATE TABLE "AnalysisReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "AnalysisType" NOT NULL,
    "status" "AnalysisStatus" NOT NULL,
    "filePath" TEXT,
    "language" TEXT,
    "result" JSONB NOT NULL,
    "error" TEXT,
    "progress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vulnerability" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "severity" "VulnSeverity" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER NOT NULL,
    "codeSnippet" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "cwe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vulnerability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeExplanation" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "symbolName" TEXT,
    "symbolType" TEXT,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "detailed" TEXT NOT NULL,
    "complexity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeExplanation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisReport_projectId_idx" ON "AnalysisReport"("projectId");

-- CreateIndex
CREATE INDEX "AnalysisReport_projectId_type_idx" ON "AnalysisReport"("projectId", "type");

-- CreateIndex
CREATE INDEX "AnalysisReport_status_idx" ON "AnalysisReport"("status");

-- CreateIndex
CREATE INDEX "Vulnerability_reportId_idx" ON "Vulnerability"("reportId");

-- CreateIndex
CREATE INDEX "Vulnerability_severity_idx" ON "Vulnerability"("severity");

-- CreateIndex
CREATE INDEX "Vulnerability_type_idx" ON "Vulnerability"("type");

-- CreateIndex
CREATE INDEX "CodeExplanation_reportId_idx" ON "CodeExplanation"("reportId");

-- CreateIndex
CREATE INDEX "CodeExplanation_filePath_idx" ON "CodeExplanation"("filePath");

-- CreateIndex
CREATE INDEX "CodeExplanation_symbolType_idx" ON "CodeExplanation"("symbolType");

-- AddForeignKey
ALTER TABLE "AnalysisReport" ADD CONSTRAINT "AnalysisReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vulnerability" ADD CONSTRAINT "Vulnerability_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AnalysisReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeExplanation" ADD CONSTRAINT "CodeExplanation_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "AnalysisReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
