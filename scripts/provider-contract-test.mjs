import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  S3ProviderAdapter,
  assertSafeProviderEndpoint,
  createSafeProviderLookup,
} from "../packages/provider-s3/dist/index.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(scriptDirectory, "../.local/secrets/provider-test.json");
const requestTimeoutMs = 20_000;
const multipartPartSizeBytes = 5 * 1024 * 1024;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(config, name) {
  if (typeof config[name] !== "string" || config[name].trim() === "") {
    throw new Error(`provider-test.json requires a non-empty string: ${name}`);
  }
  return config[name].trim();
}

function optionalBoolean(config, name, fallback = false) {
  if (config[name] === undefined) return fallback;
  if (typeof config[name] !== "boolean") {
    throw new Error(`provider-test.json field ${name} must be boolean`);
  }
  return config[name];
}

function optionalPorts(config) {
  if (config.allowedPorts === undefined) return undefined;
  if (
    !Array.isArray(config.allowedPorts) ||
    config.allowedPorts.length === 0 ||
    config.allowedPorts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
    )
  ) {
    throw new Error(
      "provider-test.json field allowedPorts must contain valid TCP ports",
    );
  }
  return [...new Set(config.allowedPorts)];
}

async function readConfig() {
  let fileStats;
  try {
    fileStats = await stat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Provider test config is missing at ${configPath}; copy the documented example first`,
      );
    }
    throw error;
  }

  if ((fileStats.mode & 0o077) !== 0) {
    throw new Error(
      "provider-test.json must not be group/world readable; run chmod 600 on the file",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("provider-test.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("provider-test.json must contain a JSON object");
  }

  const allowHttp = optionalBoolean(parsed, "allowHttp");
  const allowPrivateNetwork = optionalBoolean(parsed, "allowPrivateNetwork");
  const allowedPorts = optionalPorts(parsed);
  const addressingMode = parsed.addressingMode ?? "PATH_STYLE";
  if (!["AUTO", "VIRTUAL_HOSTED", "PATH_STYLE"].includes(addressingMode)) {
    throw new Error(
      "provider-test.json addressingMode must be AUTO, VIRTUAL_HOSTED, or PATH_STYLE",
    );
  }

  const endpoint = requiredString(parsed, "endpoint");
  const bucket = requiredString(parsed, "bucket");
  const region = requiredString(parsed, "region");
  const accessKeyId = requiredString(parsed, "accessKeyId");
  const secretAccessKey = requiredString(parsed, "secretAccessKey");

  const safeEndpoint = await assertSafeProviderEndpoint(endpoint, {
    allowHttp,
    allowPrivateNetwork,
    ...(allowedPorts ? { allowedPorts } : {}),
  });

  return {
    endpoint: safeEndpoint.toString(),
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(typeof parsed.sessionToken === "string" && parsed.sessionToken.trim()
      ? { sessionToken: parsed.sessionToken.trim() }
      : {}),
    addressingMode,
    allowPrivateNetwork,
  };
}

async function request(url, init) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} request returned HTTP ${response.status}`);
  }
  return response;
}

function assertEqualBytes(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new Error(`${label} returned ${actual.length} bytes; expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${label} body does not match the uploaded payload`);
    }
  }
}

async function runBasicContract(adapter, bucket) {
  const key = `.mosp-contract-tests/${randomUUID()}`;
  const payload = Buffer.from("mosp provider contract test\n", "utf8");
  let cleanupError;

  try {
    const upload = await adapter.createPresignedUpload(
      bucket,
      key,
      "text/plain",
      60,
    );
    await request(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: payload,
    });

    const metadata = await adapter.headObject(bucket, key);
    if (metadata.sizeBytes !== BigInt(payload.length)) {
      throw new Error(
        `HEAD returned ${metadata.sizeBytes} bytes; expected ${payload.length}`,
      );
    }

    const download = await adapter.createPresignedDownload(bucket, key, 60);
    const downloaded = Buffer.from(await (await request(download.url, { method: "GET" })).arrayBuffer());
    assertEqualBytes(downloaded, payload, "GET");
  } finally {
    try {
      if (await adapter.objectExists(bucket, key)) {
        await adapter.deleteObject(bucket, key);
      }
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError) {
    throw new Error(
      `Contract object cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}

async function runMultipartContract(adapter, bucket) {
  const key = `.mosp-contract-tests/${randomUUID()}-multipart`;
  const firstPayload = Buffer.alloc(multipartPartSizeBytes, 0x61);
  const secondPayload = Buffer.alloc(1 * 1024 * 1024, 0x62);
  const payloads = [firstPayload, secondPayload];
  let uploadId;
  let completed = false;

  try {
    uploadId = (await adapter.createMultipartUpload(bucket, key, "application/octet-stream")).uploadId;
    const parts = [];
    for (const [index, payload] of payloads.entries()) {
      const partNumber = index + 1;
      const transfer = await adapter.createPresignedUploadPart(
        bucket,
        key,
        uploadId,
        partNumber,
        60,
      );
      const response = await request(transfer.url, {
        method: "PUT",
        headers: transfer.headers,
        body: payload,
      });
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`Multipart part ${partNumber} did not return an ETag`);
      parts.push({ etag, partNumber });
    }

    await adapter.completeMultipartUpload(bucket, key, uploadId, parts);
    completed = true;
    const metadata = await adapter.headObject(bucket, key);
    const expectedSize = payloads.reduce((total, payload) => total + payload.length, 0);
    if (metadata.sizeBytes !== BigInt(expectedSize)) {
      throw new Error(
        `Multipart HEAD returned ${metadata.sizeBytes} bytes; expected ${expectedSize}`,
      );
    }
  } finally {
    if (uploadId) {
      if (completed || (await adapter.objectExists(bucket, key))) {
        await adapter.deleteObject(bucket, key);
      } else {
        await adapter.abortMultipartUpload(bucket, key, uploadId);
      }
    }
  }
}

async function run() {
  const multipart = process.argv.slice(2).includes("--multipart");
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--multipart");
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }

  const config = await readConfig();
  const adapter = new S3ProviderAdapter({
    addressingMode: config.addressingMode,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
    endpoint: config.endpoint,
    endpointLookup: createSafeProviderLookup({
      allowPrivateNetwork: config.allowPrivateNetwork,
    }),
    region: config.region,
  });

  const connection = await adapter.testConnection(config.bucket);
  const capabilities = Object.fromEntries(
    connection.capabilities.map((capability) => [capability.capability, capability.supported]),
  );
  for (const requiredCapability of ["presignedGet", "presignedPut"]) {
    if (capabilities[requiredCapability] !== true) {
      throw new Error(`Provider does not support required capability: ${requiredCapability}`);
    }
  }
  if (multipart && capabilities.multipart !== true) {
    throw new Error("Provider does not report multipart capability; omit --multipart or fix the provider");
  }

  await runBasicContract(adapter, config.bucket);
  if (multipart) await runMultipartContract(adapter, config.bucket);

  console.log(JSON.stringify({
    endpoint: new URL(config.endpoint).origin,
    bucket: config.bucket,
    capabilities,
    basicObjectContract: "passed",
    ...(multipart ? { multipartContract: "passed" } : {}),
  }, null, 2));
}

try {
  await run();
} catch (error) {
  console.error(`Provider contract test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
