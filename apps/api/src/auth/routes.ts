import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";

import { loginRequestSchema } from "@mosp/shared";

import { clearAuthCookies, parseBearerToken, readRefreshCookie, requireCsrf, setAuthCookies, type AuthCookieOptions } from "./cookies.js";
import { RateLimiterUnavailableError, rateLimitKey, type RateLimiter } from "../security/rate-limit.js";
import { AuthFailure, type AuthRequestMetadata, type AuthService } from "./service.js";

export interface AuthRouteDependencies {
  allowedOrigins?: readonly string[];
  authService: AuthService;
  cookieOptions: AuthCookieOptions;
  rateLimiter?: RateLimiter;
}

async function rejectWhenLimited(
  response: Response,
  decision: ReturnType<RateLimiter["consume"]>,
): Promise<boolean> {
  let resolved;
  try {
    resolved = await decision;
  } catch (error) {
    if (error instanceof RateLimiterUnavailableError) {
      response.status(503).json({ error: "dependency_unavailable" });
      return true;
    }
    throw error;
  }
  if (resolved.allowed) return false;
  response.setHeader("Retry-After", resolved.retryAfterSeconds);
  response.status(429).json({ error: "rate_limited" });
  return true;
}

function hasAllowedOrigin(request: Request, allowedOrigins: readonly string[] | undefined): boolean {
  const origin = request.header("origin");
  if (!allowedOrigins) return true;
  return Boolean(origin && allowedOrigins.includes(origin));
}

function requestMetadata(request: Request): AuthRequestMetadata {
  const metadata: AuthRequestMetadata = {};
  if (request.ip) metadata.ipAddress = request.ip;
  const deviceName = request.header("x-device-name")?.slice(0, 200);
  const userAgent = request.header("user-agent")?.slice(0, 1024);

  if (deviceName) metadata.deviceName = deviceName;
  if (userAgent) metadata.userAgent = userAgent;
  return metadata;
}

function authFailureResponse(error: unknown) {
  if (error instanceof ZodError) {
    return { status: 400, body: { error: "invalid_request" } };
  }

  if (error instanceof AuthFailure) {
    if (error.code === "INVALID_CREDENTIALS" || error.code === "INVALID_REFRESH_TOKEN") {
      return { status: 401, body: { error: "unauthenticated" } };
    }

    return { status: 401, body: { error: "unauthenticated" } };
  }

  return { status: 500, body: { error: "internal_error" } };
}

export function createAuthRouter({
  allowedOrigins,
  authService,
  cookieOptions,
  rateLimiter,
}: AuthRouteDependencies) {
  const router = Router();

  router.post("/login", async (request, response) => {
    if (!hasAllowedOrigin(request, allowedOrigins)) {
      response.status(403).json({ error: "origin_not_allowed" });
      return;
    }

    try {
      const input = loginRequestSchema.parse(request.body);
      if (rateLimiter) {
        if (await rejectWhenLimited(response, rateLimiter.consume(rateLimitKey(request.ip, "login-ip")))) {
          return;
        }
        if (await rejectWhenLimited(response, rateLimiter.consume(rateLimitKey(request.ip, `login-email:${input.email}`)))) {
          return;
        }
      }
      const result = await authService.login(
        input.email,
        input.password,
        requestMetadata(request),
      );

      setAuthCookies(
        response,
        result.refreshToken,
        result.refreshTokenExpiresAt,
        cookieOptions,
      );
      response.json({
        accessToken: result.accessToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
        user: result.user,
      });
    } catch (error) {
      const mapped = authFailureResponse(error);
      response.status(mapped.status).json(mapped.body);
    }
  });

  router.post("/refresh", async (request, response) => {
    if (rateLimiter && await rejectWhenLimited(response, rateLimiter.consume(rateLimitKey(request.ip, "refresh")))) {
      return;
    }

    if (!requireCsrf(request)) {
      response.status(403).json({ error: "csrf_failed" });
      return;
    }

    const refreshToken = readRefreshCookie(request);
    if (!refreshToken) {
      clearAuthCookies(response, cookieOptions);
      response.status(401).json({ error: "unauthenticated" });
      return;
    }

    try {
      const result = await authService.refresh(
        refreshToken,
        requestMetadata(request),
      );
      setAuthCookies(
        response,
        result.refreshToken,
        result.refreshTokenExpiresAt,
        cookieOptions,
      );
      response.json({
        accessToken: result.accessToken,
        accessTokenExpiresAt: result.accessTokenExpiresAt.toISOString(),
        user: result.user,
      });
    } catch (error) {
      clearAuthCookies(response, cookieOptions);
      const mapped = authFailureResponse(error);
      response.status(mapped.status).json(mapped.body);
    }
  });

  router.post("/logout", async (request, response) => {
    if (!requireCsrf(request)) {
      response.status(403).json({ error: "csrf_failed" });
      return;
    }

    const refreshToken = readRefreshCookie(request);
    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    clearAuthCookies(response, cookieOptions);
    response.status(204).end();
  });

  router.get("/session", async (request, response) => {
    if (rateLimiter && await rejectWhenLimited(response, rateLimiter.consume(rateLimitKey(request.ip, "session")))) {
      return;
    }
    const accessToken = parseBearerToken(request);
    if (!accessToken) {
      response.status(401).json({ error: "unauthenticated" });
      return;
    }

    try {
      response.json({ user: await authService.session(accessToken) });
    } catch (error) {
      const mapped = authFailureResponse(error);
      response.status(mapped.status).json(mapped.body);
    }
  });

  return router;
}
