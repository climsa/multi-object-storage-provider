CREATE UNIQUE INDEX "MigrationRun_active_namespace_key"
  ON "MigrationRun" ("organizationId", "namespaceId")
  WHERE "state" IN ('CREATED', 'RUNNING', 'PAUSED');
