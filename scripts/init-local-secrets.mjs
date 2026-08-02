import { randomBytes } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const secretsDirectory = resolve(scriptDirectory, "../.local/secrets");

const secretFiles = {
  authSigningKey: resolve(secretsDirectory, "auth-signing-key"),
  databaseUrl: resolve(secretsDirectory, "database-url"),
  providerKek: resolve(secretsDirectory, "provider-kek"),
};

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });

if (!(await exists(secretFiles.databaseUrl))) {
  throw new Error(
    `Database URL secret is missing at ${secretFiles.databaseUrl}. Add the connection string for your existing PostgreSQL instance there; this initializer will not create a database or database credentials.`,
  );
}

const generatedFiles = [];

if (!(await exists(secretFiles.providerKek))) {
  const providerKek = randomBytes(32).toString("base64url");
  await writeFile(secretFiles.providerKek, `${providerKek}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  generatedFiles.push("provider-kek");
}

if (!(await exists(secretFiles.authSigningKey))) {
  const authSigningKey = randomBytes(32).toString("base64url");
  await writeFile(secretFiles.authSigningKey, `${authSigningKey}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  generatedFiles.push("auth-signing-key");
}

console.log(
  generatedFiles.length > 0
    ? `Created local secret files: ${generatedFiles.join(", ")}.`
    : "Local secret files already exist; nothing changed.",
);
