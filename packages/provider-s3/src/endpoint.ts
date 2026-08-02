import { lookup as dnsLookup } from "node:dns";
import { lookup as lookupAll } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

export interface EndpointValidationOptions {
  allowHttp?: boolean;
  allowPrivateNetwork?: boolean;
  allowedPorts?: readonly number[];
}

/**
 * Re-validates every socket lookup instead of trusting the DNS result observed
 * during provider registration. This closes the DNS-rebinding window between
 * endpoint validation and a later provider operation.
 */
export function createSafeProviderLookup(
  options: Pick<EndpointValidationOptions, "allowPrivateNetwork"> = {},
): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    const family = lookupOptions.family === "IPv4"
      ? 4
      : lookupOptions.family === "IPv6"
        ? 6
        : lookupOptions.family;
    dnsLookup(
      hostname,
      {
        all: true,
        order: "verbatim",
        ...(typeof family === "number"
          ? { family }
          : {}),
      },
      (error, addresses) => {
        if (error) {
          callback(error, "", 0);
          return;
        }

        const safeAddresses = options.allowPrivateNetwork
          ? addresses
          : addresses.filter((address) => !isPrivateAddress(address.address));
        if (safeAddresses.length === 0) {
          const blocked = new Error(
            "Provider endpoint resolved to a private or reserved address",
          ) as NodeJS.ErrnoException;
          blocked.code = "ERR_PROVIDER_PRIVATE_ADDRESS";
          callback(blocked, "", 0);
          return;
        }

        if (lookupOptions.all) {
          callback(null, safeAddresses);
          return;
        }

        const address = safeAddresses[0]!;
        callback(null, address.address, address.family);
      },
    );
  };
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((result, octet) => (result << 8) + octet, 0) >>> 0;
}

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  const ranges = [
    [0x00000000, 0xff000000],
    [0x0a000000, 0xff000000],
    [0x64400000, 0xffc00000],
    [0x7f000000, 0xff000000],
    [0xa9fe0000, 0xffff0000],
    [0xac100000, 0xfff00000],
    [0xc0a80000, 0xffff0000],
    [0xc6120000, 0xfffe0000],
    [0xe0000000, 0xf0000000],
    [0xf0000000, 0xf0000000],
  ] as const;

  // Bitwise operators coerce to signed 32-bit integers in JavaScript. Keep
  // the masked value unsigned so ranges above 127.0.0.0 are compared safely.
  return ranges.some(([network, mask]) => ((value & mask) >>> 0) === network);
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const hextets = parseIpv6Hextets(normalized);
  if (
    hextets &&
    hextets.slice(0, 5).every((hextet) => hextet === 0) &&
    (hextets[5] === 0xffff || hextets[5] === 0)
  ) {
    const mappedIpv4 = [
      hextets[6]! >> 8,
      hextets[6]! & 0xff,
      hextets[7]! >> 8,
      hextets[7]! & 0xff,
    ].join(".");
    return isPrivateIpv4(mappedIpv4);
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("100:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("2001:10") ||
    normalized.startsWith("2001:2") ||
    normalized.startsWith("2001:db8") ||
    normalized.startsWith("ff")
  );
}

function parseIpv6Hextets(address: string): number[] | null {
  let normalized = address;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = normalized.slice(separator + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    normalized = `${normalized.slice(0, separator)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return null;
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  const values = [...left, ...right];
  if (values.some((value) => !/^[0-9a-f]{1,4}$/.test(value))) return null;

  if (sections.length === 2) {
    const missing = 8 - values.length;
    if (missing < 1) return null;
    return [
      ...left.map((value) => Number.parseInt(value, 16)),
      ...Array.from({ length: missing }, () => 0),
      ...right.map((value) => Number.parseInt(value, 16)),
    ];
  }

  if (values.length !== 8) return null;
  return values.map((value) => Number.parseInt(value, 16));
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) return isPrivateIpv6(address);
  return false;
}

export async function assertSafeProviderEndpoint(
  endpoint: string,
  options: EndpointValidationOptions = {},
): Promise<URL> {
  const parsed = new URL(endpoint);

  if (!options.allowHttp && parsed.protocol !== "https:") {
    throw new Error("Provider endpoint must use HTTPS");
  }

  if (options.allowHttp && !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Provider endpoint must use HTTP or HTTPS");
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Provider endpoint must not contain credentials or query data");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  const allowedPorts = options.allowedPorts ?? (options.allowHttp ? [80, 443] : [443]);
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    throw new Error("Provider endpoint port is not allowed");
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : (await lookupAll(parsed.hostname, { all: true })).map((entry) => entry.address);

  if (!options.allowPrivateNetwork && addresses.some(isPrivateAddress)) {
    throw new Error("Provider endpoint resolves to a private or reserved address");
  }

  return parsed;
}
