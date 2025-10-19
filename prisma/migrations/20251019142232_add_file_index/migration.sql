-- CreateTable
CREATE TABLE "FileIndex" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "language" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "lastModified" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileIndex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileIndex_projectId_idx" ON "FileIndex"("projectId");

-- CreateIndex
CREATE INDEX "FileIndex_language_idx" ON "FileIndex"("language");

-- CreateIndex
CREATE UNIQUE INDEX "FileIndex_projectId_filePath_key" ON "FileIndex"("projectId", "filePath");

-- AddForeignKey
ALTER TABLE "FileIndex" ADD CONSTRAINT "FileIndex_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
