import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../app.js";
import { InMemoryRateLimiter, RateLimiterUnavailableError } from "../security/rate-limit.js";
import type { AuthService } from "./service.js";

const sessionResult = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date("2030-01-01T00:15:00.000Z"),
  refreshToken: "refresh-token",
  refreshTokenExpiresAt: new Date("2030-02-01T00:00:00.000Z"),
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    email: "owner@example.com",
  },
};

function createAuthApp(allowedOrigins?: readonly string[]) {
  const authService = {
    login: vi.fn().mockResolvedValue(sessionResult),
    refresh: vi.fn().mockResolvedValue({
      ...sessionResult,
      accessToken: "refreshed-access-token",
      refreshToken: "refreshed-refresh-token",
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    session: vi.fn().mockResolvedValue(sessionResult.user),
  } as unknown as AuthService;

  return {
    app: createApp({
      auth: {
        authService,
        cookieOptions: { secure: false },
        ...(allowedOrigins ? { allowedOrigins } : {}),
      },
    }),
    authService,
  };
}

describe("authentication routes", () => {
  it("returns an access token and keeps refresh token in an httpOnly cookie", async () => {
    const { app } = createAuthApp();
    const response = await request(app).post("/v1/auth/login").send({
      email: "Owner@Example.com",
      password: "password-123456",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accessToken: "access-token",
      user: sessionResult.user,
    });
    expect(response.body.refreshToken).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("mosp_refresh=refresh-token"),
        expect.stringContaining("HttpOnly"),
      ]),
    );
  });

  it("requires a matching CSRF cookie and header for refresh", async () => {
    const { app, authService } = createAuthApp();
    const response = await request(app)
      .post("/v1/auth/refresh")
      .set("Cookie", "mosp_refresh=refresh-token; mosp_csrf=csrf-token")
      .set("x-csrf-token", "wrong-token");

    expect(response.status).toBe(403);
    expect(authService.refresh).not.toHaveBeenCalled();
  });

  it("accepts refresh only after CSRF validation", async () => {
    const { app, authService } = createAuthApp();
    const response = await request(app)
      .post("/v1/auth/refresh")
      .set("Cookie", "mosp_refresh=refresh-token; mosp_csrf=csrf-token")
      .set("x-csrf-token", "csrf-token");

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBe("refreshed-access-token");
    expect(authService.refresh).toHaveBeenCalledOnce();
  });

  it("requires CSRF validation for logout", async () => {
    const { app, authService } = createAuthApp();
    const response = await request(app)
      .post("/v1/auth/logout")
      .set("Cookie", "mosp_refresh=refresh-token; mosp_csrf=csrf-token")
      .set("x-csrf-token", "wrong-token");

    expect(response.status).toBe(403);
    expect(authService.logout).not.toHaveBeenCalled();
  });

  it("rejects login requests from an untrusted origin", async () => {
    const { app, authService } = createAuthApp(["http://localhost:3000"]);
    const response = await request(app)
      .post("/v1/auth/login")
      .set("Origin", "https://attacker.example")
      .send({ email: "owner@example.com", password: "password-123456" });

    expect(response.status).toBe(403);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("rejects login requests without an origin when an allowlist is configured", async () => {
    const { app, authService } = createAuthApp(["http://localhost:3000"]);
    const response = await request(app)
      .post("/v1/auth/login")
      .send({ email: "owner@example.com", password: "password-123456" });

    expect(response.status).toBe(403);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it("enforces an optional login rate limiter", async () => {
    const authService = {
      login: vi.fn().mockResolvedValue(sessionResult),
      refresh: vi.fn(),
      logout: vi.fn(),
      session: vi.fn(),
    } as unknown as AuthService;
    const app = createApp({
      auth: {
        authService,
        cookieOptions: { secure: false },
        rateLimiter: new InMemoryRateLimiter(1, 60_000),
      },
    });

    const payload = { email: "owner@example.com", password: "password-123456" };
    await request(app).post("/v1/auth/login").send(payload);
    const response = await request(app).post("/v1/auth/login").send(payload);

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(authService.login).toHaveBeenCalledOnce();
  });

  it("fails closed when the shared rate limiter is unavailable", async () => {
    const authService = {
      login: vi.fn().mockResolvedValue(sessionResult),
      refresh: vi.fn(),
      logout: vi.fn(),
      session: vi.fn(),
    } as unknown as AuthService;
    const app = createApp({
      auth: {
        authService,
        cookieOptions: { secure: false },
        rateLimiter: {
          consume: vi.fn().mockRejectedValue(new RateLimiterUnavailableError()),
        },
      },
    });

    const response = await request(app).post("/v1/auth/login").send({
      email: "Owner@Example.com",
      password: "password-123456",
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "dependency_unavailable" });
    expect(authService.login).not.toHaveBeenCalled();
    expect(response.text).not.toContain("RATE_LIMITER_UNAVAILABLE");
  });
});
