import { NextRequest, NextResponse } from "next/server";

function contentSecurityPolicy(nonce: string): string {
  const developmentSources = process.env.NODE_ENV === "development"
    ? ["'unsafe-eval'"]
    : [];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${developmentSources.join(" ")}`.trim(),
    `style-src 'self' 'nonce-${nonce}'`,
  ].join("; ");
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
