/*
  Warnings:

  - You are about to drop the `FileIndex` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."FileIndex" DROP CONSTRAINT "FileIndex_projectId_fkey";

-- DropTable
DROP TABLE "public"."FileIndex";
