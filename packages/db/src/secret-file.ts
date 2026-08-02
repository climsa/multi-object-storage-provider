import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function localSecretPath(name: string): string {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(sourceDirectory, `../../../.local/secrets/${name}`),
    resolve(sourceDirectory, `../../../../.local/secrets/${name}`),
  ];

  return candidates.find(existsSync) ?? candidates[0]!;
}

export function resolveSecretFile(name: string): string {
  const runtimeSecret = `/run/secrets/${name}`;

  if (existsSync(runtimeSecret)) {
    return runtimeSecret;
  }

  return localSecretPath(name);
}

export async function readSecret(name: string): Promise<string> {
  const value = (await readFile(resolveSecretFile(name), "utf8")).trim();

  if (!value) {
    throw new Error(`Runtime secret file is empty: ${name}`);
  }

  return value;
}

export function readDatabaseUrl(): Promise<string> {
  return readSecret("database-url");
}
