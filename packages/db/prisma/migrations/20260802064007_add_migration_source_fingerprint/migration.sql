-- AlterTable
ALTER TABLE "MigrationItem" ADD COLUMN     "sourceEtag" VARCHAR(255),
ADD COLUMN     "sourceLastModified" TIMESTAMPTZ(3);
