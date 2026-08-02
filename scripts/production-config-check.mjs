/**
 * Validate the security-sensitive runtime contract without printing secrets.
 * This is intentionally a fail-closed preflight; it does not connect to or
 * mutate PostgreSQL, Redis, object storage, or a reverse proxy.
 */

function fail(message) {
  throw new Error(message);
}

function check(name, valid, detail) {
  return { name, status: valid ? "passed" : "failed", detail };
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function parseBoundedInteger(name, minimum, maximum, { required: requiredValue = false } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    if (requiredValue) fail(`${name} is required`);
    return null;
  }
  if (!/^\d+$/.test(raw)) fail(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseBoolean(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail(`${name} must be either true or false`);
}

function validateRedisUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("MOSP_REDIS_URL must be a valid redis:// or rediss:// URL");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    fail("MOSP_REDIS_URL must use redis:// or rediss://");
  }
  if (!parsed.hostname || !/^\/?\d*$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    fail("MOSP_REDIS_URL must contain only a Redis endpoint, optional database number, and credentials");
  }
}

function validateOrigins(value) {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) fail("MOSP_ALLOWED_ORIGINS must contain at least one origin");
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      fail("MOSP_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
      fail("Production MOSP_ALLOWED_ORIGINS must contain HTTPS origins without paths or credentials");
    }
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      fail("Production MOSP_ALLOWED_ORIGINS must not contain loopback hosts");
    }
  }
}

function run() {
  if (process.env.NODE_ENV !== "production") {
    fail("NODE_ENV must be production for this preflight");
  }

  const checks = [];
  const redisUrl = required("MOSP_REDIS_URL");
  validateRedisUrl(redisUrl);
  checks.push(check("redis_url", true, "configured without exposing its value"));

  const metricsToken = required("MOSP_METRICS_TOKEN");
  if (metricsToken.length < 32 || /\s/.test(metricsToken)) {
    fail("MOSP_METRICS_TOKEN must contain at least 32 non-whitespace characters");
  }
  checks.push(check("metrics_token", true, "configured with a non-trivial length"));

  validateOrigins(required("MOSP_ALLOWED_ORIGINS"));
  checks.push(check("allowed_origins", true, "HTTPS origins only"));

  parseBoundedInteger("MOSP_TRUST_PROXY_HOPS", 1, 10, { required: true });
  checks.push(check("trust_proxy_hops", true, "fixed proxy distance configured"));

  if (parseBoolean("MOSP_PROVIDER_ALLOW_HTTP")) {
    fail("MOSP_PROVIDER_ALLOW_HTTP must be false or unset in production");
  }
  if (parseBoolean("MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK")) {
    fail("MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK must be false or unset in production");
  }
  const providerPorts = process.env.MOSP_PROVIDER_ALLOWED_PORTS?.trim();
  if (providerPorts && providerPorts.split(",").some((port) => port.trim() !== "443")) {
    fail("MOSP_PROVIDER_ALLOWED_PORTS may contain only 443 in production");
  }
  checks.push(check("provider_egress_defaults", true, "HTTP/private-network access disabled; HTTPS/443 only"));

  parseBoundedInteger("MOSP_STORAGE_MAX_IN_FLIGHT", 1, 10_000);
  parseBoundedInteger("MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER", 1, 20);
  parseBoundedInteger("MOSP_UPLOAD_RECONCILIATION_INTERVAL_MS", 1_000, 3_600_000);
  checks.push(check("bounded_runtime_limits", true, "optional limits are within application ceilings"));

  return { status: "passed", environment: "production", checks };
}

try {
  console.log(JSON.stringify(run(), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.message : "production preflight failed",
  }, null, 2));
  process.exitCode = 1;
}
