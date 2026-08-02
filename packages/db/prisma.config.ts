import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = resolve(packageDirectory, "../..");
const databaseUrlFiles = [
  "/run/secrets/database-url",
  resolve(repositoryDirectory, ".local/secrets/database-url"),
];
const databaseUrlFile = databaseUrlFiles.find(existsSync);

if (!databaseUrlFile) {
  throw new Error(
    "Database URL secret file is missing; provide your existing PostgreSQL connection string at .local/secrets/database-url",
  );
}

const databaseUrl = readFileSync(databaseUrlFile, "utf8").trim();

if (!databaseUrl) {
  throw new Error("Database URL secret file is empty");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
