import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

describe("health endpoints", () => {
  it("reports process health", async () => {
    const response = await request(createApp()).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
  });

  it("fails readiness without exposing database details", async () => {
    const app = createApp({
      readinessCheck: async () => {
        throw new Error("sensitive database detail");
      },
    });

    const response = await request(app).get("/readyz");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable" });
    expect(response.text).not.toContain("sensitive database detail");
  });

  it("rejects malformed JSON with a controlled client error", async () => {
    const response = await request(createApp())
      .post("/v1/invalid")
      .set("Content-Type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_json" });
  });

  it("maps oversized JSON requests to a controlled 413", async () => {
    const response = await request(createApp())
      .post("/v1/invalid")
      .set("Content-Type", "application/json")
      .send({ payload: "x".repeat(1_100_000) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "request_too_large" });
  });

  it("only enables an explicitly configured proxy hop count", () => {
    const app = createApp({ trustProxy: 1 });

    expect(app.get("trust proxy")).toBe(1);
  });

  it("sets browser containment headers", async () => {
    const response = await request(createApp()).get("/healthz");

    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("marks authenticated API responses as non-cacheable", async () => {
    const response = await request(createApp()).get("/v1/unknown");

    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
  });

  it("does not opt into cross-origin browser reads by default", async () => {
    const response = await request(createApp())
      .get("/healthz")
      .set("Origin", "https://attacker.example");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
