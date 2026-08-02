-- Enforce that an object location and its object record belong to the same tenant.
ALTER TABLE "ObjectLocation" DROP CONSTRAINT "ObjectLocation_objectRecordId_fkey";

ALTER TABLE "ObjectLocation"
  ADD CONSTRAINT "ObjectLocation_objectRecordId_organizationId_fkey"
  FOREIGN KEY ("objectRecordId", "organizationId")
  REFERENCES "ObjectRecord"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
