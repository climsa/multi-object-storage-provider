/**
 * Proxy transfers are deliberately bounded. The request timeout is also used
 * by the HTTP server so a client cannot hold a stream open indefinitely.
 */
export const DEFAULT_PROXY_TRANSFER_TIMEOUT_SECONDS = 300;
export const MIN_PROXY_TRANSFER_TIMEOUT_SECONDS = 10;
export const MAX_PROXY_TRANSFER_TIMEOUT_SECONDS = 300;
export const DEFAULT_MAX_PROXY_OBJECT_BYTES = 1n * 1024n * 1024n * 1024n;
export const MAX_ALLOWED_PROXY_OBJECT_BYTES = DEFAULT_MAX_PROXY_OBJECT_BYTES;

export interface ProxyTransferConfig {
  maxObjectBytes: bigint;
  timeoutMs: number;
}

export const DEFAULT_PROXY_TRANSFER_CONFIG: ProxyTransferConfig = {
  maxObjectBytes: DEFAULT_MAX_PROXY_OBJECT_BYTES,
  timeoutMs: DEFAULT_PROXY_TRANSFER_TIMEOUT_SECONDS * 1000,
};

export function createProxyTransferConfig(
  maxObjectBytes: bigint,
  timeoutSeconds: number,
): ProxyTransferConfig {
  const safeMaxObjectBytes = maxObjectBytes >= 1n && maxObjectBytes <= MAX_ALLOWED_PROXY_OBJECT_BYTES
    ? maxObjectBytes
    : DEFAULT_MAX_PROXY_OBJECT_BYTES;
  const safeTimeoutSeconds = Number.isInteger(timeoutSeconds) &&
    timeoutSeconds >= MIN_PROXY_TRANSFER_TIMEOUT_SECONDS &&
    timeoutSeconds <= MAX_PROXY_TRANSFER_TIMEOUT_SECONDS
    ? timeoutSeconds
    : DEFAULT_PROXY_TRANSFER_TIMEOUT_SECONDS;
  return {
    maxObjectBytes: safeMaxObjectBytes,
    timeoutMs: safeTimeoutSeconds * 1000,
  };
}

// Backward-compatible aliases for callers that use the secure defaults.
export const PROXY_TRANSFER_TIMEOUT_MS = DEFAULT_PROXY_TRANSFER_CONFIG.timeoutMs;
export const MAX_PROXY_OBJECT_BYTES = DEFAULT_PROXY_TRANSFER_CONFIG.maxObjectBytes;
