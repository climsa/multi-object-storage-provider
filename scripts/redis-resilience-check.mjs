import { randomUUID } from "node:crypto";
import { createClient } from "redis";

const maxConnectTimeoutMs = 5_000;

function parseOptions(argv) {
  const options = { url: "redis://127.0.0.1:6379", expect: "available" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--url") options.url = value;
    else if (flag === "--expect") {
      if (value !== "available" && value !== "unavailable") {
        throw new Error("--expect must be available or unavailable");
      }
      options.expect = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  const parsed = new URL(options.url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("--url must use redis:// or rediss://");
  }
  return options;
}

function safeEndpoint(value) {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

function safeErrorCode(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,64}$/.test(code) ? code : "REDIS_UNAVAILABLE";
}

async function disconnect(client) {
  if (client.isOpen) await client.quit().catch(() => client.disconnect());
}

try {
  const options = parseOptions(process.argv.slice(2));
  const client = createClient({
    url: options.url,
    socket: {
      connectTimeout: maxConnectTimeoutMs,
      reconnectStrategy: false,
    },
  });
  client.on("error", () => undefined);
  const startedAt = performance.now();
  try {
    await client.connect();
  } catch (error) {
    await disconnect(client);
    const result = {
      endpoint: safeEndpoint(options.url),
      expected: options.expect,
      connected: false,
      errorCode: safeErrorCode(error),
      passed: options.expect === "unavailable",
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    process.exit();
  }

  if (options.expect === "unavailable") {
    await disconnect(client);
    console.log(JSON.stringify({
      endpoint: safeEndpoint(options.url),
      expected: options.expect,
      connected: true,
      passed: false,
    }, null, 2));
    process.exitCode = 1;
  } else {
    const key = `mosp:resilience:probe:${randomUUID()}`;
    const value = randomUUID();
    try {
      const pong = await client.ping();
      await client.set(key, value, { EX: 30 });
      const observed = await client.get(key);
      if (pong !== "PONG" || observed !== value) throw new Error("Redis SET/GET verification failed");
      await client.del(key);
      console.log(JSON.stringify({
        endpoint: safeEndpoint(options.url),
        expected: options.expect,
        connected: true,
        roundTripMs: Math.round(performance.now() - startedAt),
        ephemeralKeyDeleted: true,
        passed: true,
      }, null, 2));
    } finally {
      await disconnect(client);
    }
  }
} catch (error) {
  console.error(`Redis resilience check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
