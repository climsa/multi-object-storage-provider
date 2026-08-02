import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const databaseUrlFile = resolve(scriptDirectory, "../.local/secrets/database-url");

async function readDatabaseUrl() {
  const fileStats = await stat(databaseUrlFile).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Database URL secret is missing at ${databaseUrlFile}`);
    }
    throw error;
  });
  if ((fileStats.mode & 0o077) !== 0) {
    throw new Error("database-url must not be group/world readable; run chmod 600");
  }
  const value = (await readFile(databaseUrlFile, "utf8")).trim();
  if (!value) throw new Error("database-url must not be empty");
  return value;
}

function pgConnectionString(value) {
  try {
    const parsed = new URL(value);
    // Prisma uses this client-side parameter; libpq/pg_dump does not accept it.
    parsed.searchParams.delete("schema");
    return parsed.toString();
  } catch {
    return value;
  }
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, options);
  } catch (error) {
    const code = typeof error?.code === "number" ? ` (exit ${error.code})` : "";
    throw new Error(`${basename(command)} failed${code}`);
  }
}

async function requireCommand(command) {
  const candidates = [
    command,
    `/opt/homebrew/opt/libpq/bin/${command}`,
    `/usr/local/opt/libpq/bin/${command}`,
  ];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { maxBuffer: 1 * 1024 * 1024 });
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") return candidate;
    }
  }
  throw new Error(`${command} is required for backup validation; install PostgreSQL client tools`);
}

try {
  const connectionString = await readDatabaseUrl();
  const pgDumpCommand = await requireCommand("pg_dump");
  const pgRestoreCommand = await requireCommand("pg_restore");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "mosp-postgres-backup-"));
  const archivePath = join(temporaryDirectory, "metadata.dump");
  await chmod(temporaryDirectory, 0o700);
  await chmod(archivePath, 0o600).catch(() => undefined);

  try {
    await runCommand(pgDumpCommand, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      archivePath,
      "--dbname",
      pgConnectionString(connectionString),
    ], { maxBuffer: 4 * 1024 * 1024 });
    await chmod(archivePath, 0o600);
    const archiveStats = await stat(archivePath);
    if (archiveStats.size < 1) throw new Error("pg_dump produced an empty archive");

    const listing = await runCommand(pgRestoreCommand, ["--list", archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!listing.stdout.includes("TABLE")) throw new Error("pg_restore archive listing contains no tables");

    console.log(JSON.stringify({
      status: "backup_validated",
      archiveBytes: archiveStats.size,
      restore: "not_run",
      restoreReason: "A disposable PostgreSQL target is required; the active database is never modified by this script.",
    }, null, 2));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`PostgreSQL backup validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
