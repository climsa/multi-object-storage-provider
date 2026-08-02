const maxAttempts = 60;
const maxIntervalMs = 60_000;
const requestTimeoutMs = 5_000;

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
    url: "http://127.0.0.1:4000/readyz",
    attempts: 1,
    intervalMs: 1_000,
    expect: "ready",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === "--url") {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("--url must use HTTP(S)");
      options.url = parsed.toString();
    } else if (flag === "--attempts") {
      options.attempts = parsePositiveInteger(value, flag, maxAttempts);
    } else if (flag === "--interval-ms") {
      options.intervalMs = parsePositiveInteger(value, flag, maxIntervalMs);
    } else if (flag === "--expect") {
      if (value !== "ready" && value !== "unready") throw new Error("--expect must be ready or unready");
      options.expect = value;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    return { status: response.status, ready: response.status === 200 };
  } catch {
    return { status: null, ready: false };
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  const observations = [];
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    observations.push(await probe(options.url));
    if (attempt + 1 < options.attempts) await sleep(options.intervalMs);
  }
  const expectedReady = options.expect === "ready";
  const passed = observations.every((observation) => observation.ready === expectedReady);
  console.log(JSON.stringify({
    url: options.url,
    expected: options.expect,
    attempts: observations.length,
    observations,
    passed,
  }, null, 2));
  if (!passed) process.exitCode = 1;
} catch (error) {
  console.error(`Readiness probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
