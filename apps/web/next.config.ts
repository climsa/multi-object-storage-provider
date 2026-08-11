import type { NextConfig } from "next";

function apiOrigin(): string | null {
  const configured = process.env.MOSP_API_ORIGIN?.trim();
  if (!configured && process.env.NODE_ENV !== "development") return null;
  const value = configured || "http://127.0.0.1:4000";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("MOSP_API_ORIGIN must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("MOSP_API_ORIGIN must contain only an HTTP(S) origin");
  }
  return parsed.origin;
}

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  poweredByHeader: false,
  async rewrites() {
    const origin = apiOrigin();
    if (!origin) return [];
    // Keep browser calls same-origin on :3000. Next forwards the API request
    // server-side to :4000 in local development (or the configured origin).
    // This avoids exposing a second browser origin and avoids a CORS/cookie
    // split between the web session and the API.
    return [
      { source: "/v1/:path*", destination: `${origin}/v1/:path*` },
      { source: "/storage/:path*", destination: `${origin}/storage/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
