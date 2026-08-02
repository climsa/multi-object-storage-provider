import { timingSafeEqual } from "node:crypto";

import { parseCookie, stringifySetCookie } from "cookie";
import type { Request, Response } from "express";

import { createRefreshToken } from "@mosp/auth";

export const REFRESH_COOKIE_NAME = "mosp_refresh";
export const CSRF_COOKIE_NAME = "mosp_csrf";
const REFRESH_COOKIE_PATH = "/v1/auth";
// The dashboard is served at / and must echo this non-HttpOnly token on
// refresh/logout. The refresh token itself remains scoped to auth routes.
const CSRF_COOKIE_PATH = "/";

export interface AuthCookieOptions {
  secure: boolean;
}

export function setAuthCookies(
  response: Response,
  refreshToken: string,
  refreshTokenExpiresAt: Date,
  options: AuthCookieOptions,
): string {
  const csrfToken = createRefreshToken();
  const maxAge = Math.max(
    0,
    Math.floor((refreshTokenExpiresAt.getTime() - Date.now()) / 1000),
  );
  response.append(
    "Set-Cookie",
    stringifySetCookie({ name: REFRESH_COOKIE_NAME, value: refreshToken, ...{
      httpOnly: true,
      maxAge,
      path: REFRESH_COOKIE_PATH,
      sameSite: "lax",
      secure: options.secure,
    }}),
  );
  response.append(
    "Set-Cookie",
    stringifySetCookie({ name: CSRF_COOKIE_NAME, value: csrfToken, ...{
      maxAge,
      path: CSRF_COOKIE_PATH,
      sameSite: "lax",
      secure: options.secure,
    }}),
  );

  return csrfToken;
}

export function clearAuthCookies(
  response: Response,
  options: AuthCookieOptions,
): void {
  for (const cookieName of [REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME]) {
    response.append(
      "Set-Cookie",
      stringifySetCookie({ name: cookieName, value: "", ...{
        httpOnly: cookieName === REFRESH_COOKIE_NAME,
        maxAge: 0,
        path: cookieName === REFRESH_COOKIE_NAME ? REFRESH_COOKIE_PATH : CSRF_COOKIE_PATH,
        sameSite: "lax",
        secure: options.secure,
      }}),
    );
  }
}

export function readRefreshCookie(request: Request): string | null {
  return parseCookie(request.headers.cookie ?? "")[REFRESH_COOKIE_NAME] ?? null;
}

export function requireCsrf(request: Request): boolean {
  const cookieToken = parseCookie(request.headers.cookie ?? "")[CSRF_COOKIE_NAME];
  const headerToken = request.header("x-csrf-token");

  if (!cookieToken || !headerToken || cookieToken.length !== headerToken.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(cookieToken, "utf8"),
    Buffer.from(headerToken, "utf8"),
  );
}

export function parseBearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}
