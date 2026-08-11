import { describe, expect, it } from "vitest";

import { assertSafeProviderEndpoint, createSafeProviderLookup } from "./endpoint.js";

describe("assertSafeProviderEndpoint", () => {
  it("rejects credentials and query data in endpoints", async () => {
    await expect(
      assertSafeProviderEndpoint("https://user:secret@example.com/?token=1"),
    ).rejects.toThrow("credentials or query data");
  });

  it("rejects HTTP endpoints by default", async () => {
    await expect(assertSafeProviderEndpoint("http://storage.example.com")).rejects.toThrow(
      "must use HTTPS",
    );
  });

  it("allows local development endpoints only when explicitly enabled", async () => {
    await expect(
      assertSafeProviderEndpoint("http://127.0.0.1:9000", {
        allowHttp: true,
        allowPrivateNetwork: true,
        allowedPorts: [9000],
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("allows HTTPS alongside the local MinIO port when both are allowlisted", async () => {
    await expect(
      assertSafeProviderEndpoint("https://127.0.0.1", {
        allowHttp: true,
        allowPrivateNetwork: true,
        allowedPorts: [80, 443, 9000],
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("rejects ports outside the explicit allowlist", async () => {
    await expect(
      assertSafeProviderEndpoint("https://storage.example.com:8443", {
        allowedPorts: [443],
      }),
    ).rejects.toThrow("port is not allowed");
  });

  it("blocks loopback IPv6 literals", async () => {
    await expect(
      assertSafeProviderEndpoint("https://[::1]"),
    ).rejects.toThrow("private or reserved");
  });

  it.each([
    "https://[::ffff:7f00:1]",
    "https://[::ffff:c0a8:101]",
  ])("blocks IPv4-mapped IPv6 private literals %s", async (endpoint) => {
    await expect(assertSafeProviderEndpoint(endpoint)).rejects.toThrow(
      "private or reserved",
    );
  });

  it.each([
    "https://192.168.1.10",
    "https://172.16.10.10",
    "https://169.254.169.254",
    "https://198.18.0.1",
  ])("blocks private or reserved IPv4 literal %s", async (endpoint) => {
    await expect(assertSafeProviderEndpoint(endpoint)).rejects.toThrow(
      "private or reserved",
    );
  });

  it("rechecks DNS results at socket lookup time", async () => {
    const lookup = createSafeProviderLookup();
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("127.0.0.1", { all: false, family: 0 }, (lookupError) => resolve(lookupError));
    });

    expect(error?.code).toBe("ERR_PROVIDER_PRIVATE_ADDRESS");
  });

  it("blocks IPv4-mapped IPv6 addresses during socket lookup", async () => {
    const lookup = createSafeProviderLookup();
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("::ffff:7f00:1", { all: false, family: 6 }, (lookupError) => resolve(lookupError));
    });

    expect(error?.code).toBe("ERR_PROVIDER_PRIVATE_ADDRESS");
  });

  it("allows private addresses only when explicitly enabled", async () => {
    const lookup = createSafeProviderLookup({ allowPrivateNetwork: true });
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("127.0.0.1", { all: false, family: 0 }, (error, address, family) => {
        if (error || typeof address !== "string") {
          reject(error ?? new Error("lookup did not return an address"));
          return;
        }
        if (family === undefined) {
          reject(new Error("lookup did not return an address family"));
          return;
        }
        resolve({ address, family });
      });
    });

    expect(result.address).toBe("127.0.0.1");
    expect(result.family).toBe(4);
  });
});
