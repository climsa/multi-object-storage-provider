import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPrismaClient } from "../packages/db/dist/src/prisma-client.js";
import { LocalFileKeyEncryptionKeyProvider, ProviderCredentialCipher } from "../packages/storage-core/dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const databaseUrlFile = resolve(scriptDirectory, "../.local/secrets/database-url");
const applyConfirmation = "ROTATE_PROVIDER_KEYS";
const maxBatchSize = 100;

function parsePositiveInteger(value, name, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseOptions(argv) {
  const options = {
    currentKeyFile: undefined,
    currentKeyVersion: undefined,
    previousKeyFiles: {},
    batchSize: 25,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    if (flag === "--apply") {
      const token = inlineValue ?? argv[++index];
      if (token !== applyConfirmation) throw new Error(`--apply must equal ${applyConfirmation}`);
      options.apply = true;
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--current-key-file") options.currentKeyFile = value;
    else if (flag === "--current-key-version") options.currentKeyVersion = value;
    else if (flag === "--previous-key") {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) {
        throw new Error("--previous-key must use VERSION=FILE format");
      }
      options.previousKeyFiles[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (flag === "--batch-size") {
      options.batchSize = parsePositiveInteger(value, flag, maxBatchSize);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!options.currentKeyFile || !options.currentKeyVersion) {
    throw new Error("--current-key-file and --current-key-version are required");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.currentKeyVersion)) {
    throw new Error("--current-key-version is invalid");
  }
  return options;
}

async function readProtectedFile(path, label) {
  const fileStats = await stat(path);
  if ((fileStats.mode & 0o077) !== 0) throw new Error(`${label} must not be group/world readable; run chmod 600`);
  return path;
}

async function readDatabaseUrl() {
  await readProtectedFile(databaseUrlFile, "database-url");
  const value = (await readFile(databaseUrlFile, "utf8")).trim();
  if (!value) throw new Error("database-url must not be empty");
  return value;
}

function envelopeFromRecord(record) {
  return {
    algorithm: record.algorithm,
    authTag: record.authTag,
    encryptedDataKey: record.encryptedDataKey,
    encryptedPayload: record.encryptedPayload,
    formatVersion: record.formatVersion,
    iv: record.iv,
    keyVersion: record.keyVersion,
  };
}

try {
  const options = parseOptions(process.argv.slice(2));
  await readProtectedFile(options.currentKeyFile, "current key file");
  for (const [version, path] of Object.entries(options.previousKeyFiles)) {
    if (version === options.currentKeyVersion) throw new Error("Current key version cannot also be previous");
    await readProtectedFile(path, `previous key file for ${version}`);
  }

  const database = createPrismaClient(await readDatabaseUrl());
  try {
    const counts = Object.create(null);
    let cursor;
    let total = 0;
    let alreadyCurrent = 0;
    let eligible = 0;
    let updated = 0;
    let conflicts = 0;
    const failures = [];
    const cipher = new ProviderCredentialCipher(
      new LocalFileKeyEncryptionKeyProvider(
        options.currentKeyFile,
        options.currentKeyVersion,
        options.previousKeyFiles,
      ),
    );

    while (true) {
      const records = await database.providerCredential.findMany({
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        take: options.batchSize,
        select: {
          id: true,
          providerConnectionId: true,
          encryptedPayload: true,
          encryptedDataKey: true,
          iv: true,
          authTag: true,
          algorithm: true,
          formatVersion: true,
          keyVersion: true,
        },
      });
      if (records.length === 0) break;

      for (const record of records) {
        total += 1;
        counts[record.keyVersion] = (counts[record.keyVersion] ?? 0) + 1;
        if (record.keyVersion === options.currentKeyVersion) {
          alreadyCurrent += 1;
          continue;
        }
        eligible += 1;
        if (!options.apply) continue;
        try {
          const rotated = await cipher.reEncrypt(record.providerConnectionId, envelopeFromRecord(record));
          const result = await database.providerCredential.updateMany({
            where: { id: record.id, keyVersion: record.keyVersion },
            data: {
              encryptedPayload: Buffer.from(rotated.encryptedPayload),
              encryptedDataKey: Buffer.from(rotated.encryptedDataKey),
              iv: Buffer.from(rotated.iv),
              authTag: Buffer.from(rotated.authTag),
              algorithm: rotated.algorithm,
              formatVersion: rotated.formatVersion,
              keyVersion: rotated.keyVersion,
              rotatedAt: new Date(),
            },
          });
          if (result.count === 1) updated += 1;
          else conflicts += 1;
        } catch (error) {
          failures.push({ keyVersion: record.keyVersion, code: error instanceof Error ? error.name : "ROTATION_FAILED" });
        }
      }
      cursor = records[records.length - 1]?.id;
    }

    const result = {
      mode: options.apply ? "apply" : "dry-run",
      currentKeyVersion: options.currentKeyVersion,
      total,
      keyVersionCounts: counts,
      alreadyCurrent,
      eligible,
      updated,
      conflicts,
      failures: failures.length,
    };
    console.log(JSON.stringify(result, null, 2));
    if (options.apply && failures.length > 0) process.exitCode = 1;
  } finally {
    await database.$disconnect();
  }
} catch (error) {
  console.error(`Provider credential key rotation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
