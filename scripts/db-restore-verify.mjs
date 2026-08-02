import { basename } from "node:path";
import { dirname, resolve } from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const activeDatabaseSecretFile = resolve(scriptDirectory, "../.local/secrets/database-url");
const restoreConfirmation = "RESTORE_DISPOSABLE_DATABASE";

function parseOptions(argv) {
  const options = { archive: undefined, targetSecretFile: undefined, confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--confirm-disposable") {
      const token = inlineValue ?? argv[++index];
      if (token !== restoreConfirmation) throw new Error(`--confirm-disposable must equal ${restoreConfirmation}`);
      options.confirm = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--archive") options.archive = value;
    else if (flag === "--target-secret-file") options.targetSecretFile = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.archive || !options.targetSecretFile || !options.confirm) {
    throw new Error(`Usage: --archive <file> --target-secret-file <file> --confirm-disposable ${restoreConfirmation}`);
  }
  return options;
}

async function readSecretFile(path) {
  const fileStats = await stat(path);
  if ((fileStats.mode & 0o077) !== 0) throw new Error(`${path} must not be group/world readable; run chmod 600`);
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${path} must not be empty`);
  return value;
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
  throw new Error(`${command} is required; install PostgreSQL client tools`);
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, options);
  } catch (error) {
    const code = typeof error?.code === "number" ? ` (exit ${error.code})` : "";
    throw new Error(`${basename(command)} failed${code}`);
  }
}

function databaseIdentity(connectionString) {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("Target connection string must include a database name");
  return `${parsed.hostname}:${parsed.port || "5432"}/${database}`;
}

function isRestoreDatabase(connectionString) {
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return /(?:_restore|-restore)$/i.test(database);
}

try {
  const options = parseOptions(process.argv.slice(2));
  await access(options.archive, constants.R_OK);
  const archiveStats = await stat(options.archive);
  if (!archiveStats.isFile()) throw new Error("--archive must point to a regular file");
  if ((archiveStats.mode & 0o077) !== 0) throw new Error("Archive must not be group/world readable; run chmod 600");

  const targetConnectionString = await readSecretFile(options.targetSecretFile);
  if (!isRestoreDatabase(targetConnectionString)) {
    throw new Error("Restore target database name must end with _restore or -restore");
  }
  const targetIdentity = databaseIdentity(targetConnectionString);
  const activeIdentity = databaseIdentity(await readSecretFile(activeDatabaseSecretFile));
  if (targetIdentity === activeIdentity) {
    throw new Error("Restore target must not be the active application database");
  }
  const pgRestoreCommand = await requireCommand("pg_restore");
  const listing = await runCommand(pgRestoreCommand, ["--list", options.archive], {
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!listing.stdout.includes("TABLE")) throw new Error("Archive listing contains no tables");

  await runCommand(pgRestoreCommand, [
    "--exit-on-error",
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
    "--dbname",
    targetConnectionString,
    options.archive,
  ], { maxBuffer: 4 * 1024 * 1024 });

  console.log(JSON.stringify({
    status: "restore_validated",
    target: targetIdentity,
    archiveBytes: archiveStats.size,
    destructiveScope: "disposable target only",
  }, null, 2));
} catch (error) {
  console.error(`PostgreSQL restore validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
