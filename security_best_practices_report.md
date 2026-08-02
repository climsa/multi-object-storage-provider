# Security Best-Practices Recheck

Date: 2026-08-02  
Scope: Express API, authentication and authorization, storage lifecycle and
upload/download flows, provider endpoint validation, placement, migration
worker, Next.js administration UI, observability, secret handling, and
dependency hygiene.

This is a repository-based review. Reverse-proxy/WAF rules, cloud egress
policies, DNS controls, object-storage bucket policies, and runtime IAM were
not present in the repository and could not be verified. The follow-up fix pass
implemented the application-level controls below, including the checked-in
PostgreSQL migrations `20260801220000_add_auth_session_ids` and
`20260802130000_add_proxied_transfer_mode`.

## Executive summary

The current code has strong development foundations: tenant-scoped Prisma
relations and queries, action-level authorization, hashed API credentials,
scrypt password verification with a dummy hash, rotated hashed refresh tokens,
HttpOnly/SameSite cookies with CSRF checks, strict Zod schemas, encrypted
provider credentials, bounded request IDs, generic error responses, explicit
Node timeouts, and default-deny provider HTTP/private-network flags.

`npm audit --audit-level=high` and the full test/type/build/database checks are
clean. The code-level findings in this report are fixed or explicitly bounded.
Remaining work is deployment-specific: controlled egress/redirect policy,
production Redis and metrics secret configuration, object-store IAM/bucket
policy, and selection of a supported stable Next.js release.

### JS-DATA-002 — Medium — Object deletion/overwrite can strand physical data

**Status:** Fixed with stateful cleanup and reconciliation  
**Location:** `apps/api/src/storage/object-service.ts`,
`apps/api/src/storage/upload-service.ts`, `apps/worker/src/upload-reconciliation.ts`

**Risk:** A provider call can succeed while the API process fails before the
metadata transition, or an overwrite can leave the previous physical location
behind. A naive retry could double-decrement quota or expose a stale location.

**Fix applied:** Deletes claim `AVAILABLE -> DELETING` before the provider call,
finalize with state guards, decrement usage in the same transaction, and emit
audit events. Overwrite is explicit, atomically switches the active location,
and marks the prior location `RETAINED`. The worker retries `DELETING` and
`RETAINED` cleanup with bounded batches; reusing a deleted logical key reuses
the tombstone row instead of violating the unique key.

**Residual:** A provider that acknowledges deletion but later restores an
object is outside the S3 contract and requires provider-side versioning policy.

### JS-DATA-003 — Medium — Cross-provider migration is a high-volume data path

**Status:** Fixed with bounded, resumable workflow  
**Location:** `apps/api/src/migrations`, `apps/worker/src/migration-reconciliation.ts`

**Risk:** Copying an object and switching its pointer are separate external and
database operations. Crashes, source mutation, retries, or cancellation could
create duplicate data, stale pointers, or unbounded worker load.

**Fix applied:** Migration creation requires organization authorization,
healthy active source/target buckets, a 10,000-object cap, and an audit event.
Items use explicit `PENDING/COPYING/COMPLETED/SKIPPED/FAILED` state, stale-copy
reclaim, stream-based transfer, destination size/checksum verification, and a
transactional active-location switch guarded by the original source pointer.
Cancelled items are provider-deleted by the worker before being marked skipped.

The worker also captures the source ETag/last-modified fingerprint at planning
time, verifies it before and after copying, removes an uncommitted target when
the source changes, and limits concurrent copies per provider through
`MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER`.

**Residual:** The API does not yet support historical object versions, and
provider-side replication/versioning behavior is intentionally outside the MVP.

### JS-OBS-001 — Low — Metrics endpoint could expose operational metadata

**Status:** Fixed by default-deny access  
**Location:** `apps/api/src/observability/metrics.ts`, `apps/api/src/app.ts`

`/metrics` returns 404 unless a deployment-provided `MOSP_METRICS_TOKEN` is
configured and presented as a bearer token or header. Route labels are
normalized to Express templates (or `unmatched`) to prevent attacker-controlled
cardinality. The endpoint never includes object keys, credentials, or payloads;
bounded gateway saturation signals are exposed as
`mosp_storage_in_flight` and `mosp_storage_overloaded_total`.

## Findings

### JS-SSRF-001 — High — Provider endpoint is not protected by a runtime SSRF boundary

**Status:** Fixed at the application layer; deployment egress remains required
**Location:** `packages/provider-s3/src/endpoint.ts:73-81`,
`apps/api/src/providers/service.ts:345-369`,
`apps/worker/src/provider-resolver.ts:47-70`

**Evidence before fix:** `assertSafeProviderEndpoint` resolved a hostname and
checked its addresses once, then `S3ProviderAdapter` was constructed with the
original hostname. Later AWS SDK connections performed fresh DNS resolution.

**Fix applied:** `createSafeProviderLookup` now revalidates every DNS result
used by the AWS SDK socket and filters private/reserved addresses unless the
explicit development flag is enabled. API and worker adapters use a bounded
`NodeHttpHandler` with the guarded HTTP(S) agents.

**Residual:** A network-level egress policy and an explicit redirect policy are
still recommended because they cannot be proven from application code alone.
IPv4-mapped IPv6 literals are canonicalized before private/reserved range
checks, including compressed hex forms such as `::ffff:7f00:1`.

**Impact:** A provider endpoint that changes DNS after validation can rebind to
a private, loopback, link-local, metadata, or other restricted address. A
redirect or permissive network route can also turn provider probes and storage
operations into an internal network pivot. The provider endpoint is
administratively configured, but an authorized provider administrator is still
an SSRF-capable principal if the network boundary is absent.

**Next fix:** Route provider traffic through a controlled egress proxy/connector
that enforces network policy and rejects redirects to unapproved destinations.
Keep the per-socket lookup guard and add integration tests for DNS rebinding
and redirect behavior.

**Mitigation:** Enforce container/VPC egress deny rules for RFC1918, loopback,
link-local, metadata, multicast, and reserved ranges. Keep provider workers
separate from the public API where practical.

**False-positive note:** The current literal/DNS preflight and socket lookup
guard are useful defense in depth and correctly default to public HTTPS/443;
they do not by themselves prove a complete network boundary.

### JS-DOS-001 — Medium — Storage upload endpoints permit unbounded session creation

**Status:** Fixed  
**Location:** `apps/api/src/storage/routes.ts:114-234`,
`apps/api/src/storage/upload-service.ts:50-208`,
`packages/shared/src/upload.ts:5-20`,
`apps/worker/src/upload-reconciliation.ts:31-79`

**Evidence before fix:** Storage list, upload initiation, multipart-part
presign, completion, and abort routes had no rate limiter or concurrency
budget. The upload schema permitted `sizeBytes: "0"`; initiation incremented
`activeUploadCount` but did not enforce a maximum. The worker only reclaimed
expired `INITIATED` sessions; terminal rows were not pruned.

**Impact:** A valid API credential can create large numbers of zero-byte or
small sessions, amplify database writes and `lastUsedAt` updates, consume
provider request capacity, and grow metadata tables. The same path can keep
quota reservations and provider objects alive until reconciliation. This is an
availability and cost-abuse risk even when byte quotas are enforced.

**Fix applied:** Storage routes now use the shared limiter and upload
initiation enforces bounded active sessions under a locked usage-counter
transaction. Reconciliation prunes old terminal sessions in bounded batches,
and failed size/checksum verification cleans provider state and releases the
reservation. Production uses the Redis-backed limiter described below.

**Mitigation:** Apply equivalent limits at the ingress/WAF and monitor upload
session creation, abort, expiry, and provider-operation rates.

**False-positive note:** Zero-byte objects and retryable uploads may be valid
product behavior; the finding is the absence of a separate active-session and
retention control, not the existence of those features.

### JS-DOS-002 — Medium — Rate limiting is process-local and does not cover all expensive paths

**Status:** Fixed for production; in-memory fallback retained for local development  
**Location:** `apps/api/src/server.ts:118-121`,
`apps/api/src/security/rate-limit.ts:15-56`,
`apps/api/src/providers/routes.ts:95-225`,
`apps/api/src/buckets/routes.ts:100-160`

**Evidence before fix:** Auth and provider/bucket limits used
`InMemoryRateLimiter`, whose state was a bounded `Map` inside one Node process;
storage operations did not share a limiter.

**Impact:** With multiple API instances, an attacker can multiply the effective
limit by routing requests across instances. Provider probes, database-backed
storage operations, and presign calls can still consume resources without a
shared budget.

**Fix applied:** `RedisRateLimiter` uses an atomic `INCR`/`PEXPIRE` Lua script
and is wired into auth, provider, bucket, and storage routes. Production fails
closed when `MOSP_REDIS_URL` is absent; non-production may use the documented
single-process fallback. Storage gateway work is also bounded by
`MOSP_STORAGE_MAX_IN_FLIGHT` and saturated requests fail with a retryable 503
instead of accumulating an unbounded queue. Upload concurrency is separately
bounded in the database transaction.

**Mitigation:** Keep the in-memory limiter only for single-process local
development and enforce limits at the reverse proxy in every deployed
environment.

**False-positive note:** The current single-process development server is
bounded by the in-memory map; the risk appears when it is horizontally scaled
or exposed without an upstream limiter.

### JS-DATA-001 — Medium — Multipart finalization has a crash window that can strand provider objects and quota

**Status:** Fixed with crash recovery and bounded cleanup  
**Location:** `apps/api/src/storage/upload-service.ts:293-307`,
`apps/worker/src/upload-reconciliation.ts:67-80`

**Evidence:** The service calls `CompleteMultipartUpload` at the provider and
only afterward updates `UploadSession.providerUploadFinalized` in PostgreSQL.
A process/database failure between those operations leaves the provider upload
completed while the database still says it is not finalized. Reconciliation
then attempts `AbortMultipartUpload` for the stale state and may leave the
session and reservation retryable indefinitely.

**Impact:** Repeated failures can orphan completed objects, leak provider
storage, and strand reserved quota/active-upload counters. This is an integrity
and availability risk in a retry or crash scenario.

**Fix applied:** Completion and worker reconciliation check provider object
existence before completing or aborting multipart state. A stale completed
object is deleted safely when the database state is terminal, and failed final
metadata verification cleans the provider object/parts and releases quota.
The existing bounded worker retry/error reporting remains in place.

**Mitigation:** Keep the worker running with bounded retries and alert on
`failed` reconciliation results; do not treat a provider abort error as proof
that the object is absent.

**False-positive note:** Some S3-compatible providers may make completion
idempotent, but the database/provider state gap still exists across a process
crash and cannot be assumed away.

### JS-AUTH-001 — Medium — Access tokens remain valid after logout

**Status:** Fixed  
**Location:** `apps/api/src/auth/service.ts:124-145`,
`packages/auth/src/jwt-service.ts:36-68`

**Evidence before fix:** Logout revoked only the refresh-token hash. Access
JWTs contained a session ID but `session()` did not check revoked session state.

**Impact:** A stolen access token can continue to authorize requests for up to
the 15-minute access-token lifetime after logout or refresh-token revocation.

**Fix applied:** Refresh tokens persist a `sessionId` (migration
`20260801220000_add_auth_session_ids`), access JWTs carry that ID, and
`session()` requires a non-revoked, unexpired refresh token for the same user
and session. Tokens issued before the migration have no session ID and require
re-authentication.

**Mitigation:** Keep access-token TTL short, revoke refresh state on logout,
rotate signing keys through an incident procedure, and disable the user for
urgent containment.

**False-positive note:** This is an accepted design trade-off when a bounded
15-minute window is acceptable; the current implementation no longer relies on
that trade-off because authorization checks the persisted session state.

### JS-HEADERS-001 — Medium — No deliberate CSP/HSTS policy is defined for the admin UI or API

**Status:** Fixed with per-request CSP nonce; edge TLS still required  
**Location:** `apps/api/src/app.ts:29-43`, `apps/web/next.config.ts:7-22`

**Evidence before fix:** The API and Next.js app set useful baseline headers,
but neither defined an explicit CSP or HSTS policy.

**Impact:** If an XSS or content-injection defect is introduced in the admin UI,
there is no browser-enforced CSP containment. Without HSTS, a first HTTP visit
can remain downgradeable where TLS termination is not enforcing it upstream.

**Fix applied:** The API sets a strict non-document CSP and production HSTS;
Next.js sets a per-request nonce CSP through the Next.js proxy and production HSTS.
The policy keeps object downloads on a separate origin where possible.
Deployment must still terminate TLS correctly before enabling HSTS.

**Mitigation:** Ensure the ingress adds equivalent headers and verify them in
deployment smoke tests until the policy is encoded in the application/edge
configuration.

**False-positive note:** The current admin UI renders API data through normal
React interpolation and contains no user-controlled HTML sink; this finding is
preventative for future rich-content features and deployment configuration.

### JS-XSS-001 — Low — User-controlled object content type can enable inline active content

**Status:** Fixed in application handling; isolated object origin remains recommended  
**Location:** `packages/shared/src/upload.ts:13-20`,
`packages/provider-s3/src/adapter.ts:157-191`,
`apps/api/src/storage/routes.ts:150-152`

**Evidence before fix:** Upload callers could choose any non-empty
`Content-Type` up to 255 characters, and direct downloads redirected to
provider responses without an attachment disposition.

**Impact:** If a provider endpoint is public, custom-domain mapped, or shares an
application origin, an uploaded HTML/SVG payload may execute in a browser under
that origin. This is primarily a deployment/content-policy risk, not a tenant
isolation bypass in the current admin UI.

**Fix applied:** Presigned downloads request
`Content-Disposition: attachment`; upload metadata rejects control characters;
and API `HEAD` responses sanitize reflected headers and set attachment
disposition. An isolated provider origin is still recommended for defense in
depth.

**Mitigation:** Keep provider buckets private, use short-lived signed URLs,
and do not embed object URLs in the administration origin.

**False-positive note:** If every provider is guaranteed to be an isolated
private origin and objects are never rendered inline, the exploitability is
low; the finding remains relevant for custom endpoints and future UI features.

### JS-FLOW-001 — Mitigated — Bounded full proxy transfer

**Status:** Implemented and covered by route tests plus the MinIO API smoke
test.

`PROXIED` namespaces stream uploads and downloads through the API. Uploads
require an exact `Content-Length`, use a platform-configurable size and timeout
bounded by code to 1 GiB and 300 seconds, preserve backpressure, and delete the partial
provider object while releasing the reserved quota on failure. Downloads
verify provider size against the indexed object, send attachment/no-store
headers, and meter bytes actually delivered. Provider URLs are never returned
for proxied sessions.

## Controls verified as fixed or effective

- Provider HTTP and private-network access default to `false`; ports default to
  HTTPS/443 and are explicitly allowlisted (`apps/api/src/server.ts:36-55`).
- Endpoint validation rejects credentials/query data and covers IPv4, mapped
  IPv6, loopback, link-local, multicast, and reserved ranges. The unsigned
  JavaScript bitwise comparison bug and the socket-time DNS recheck are fixed
  (`packages/provider-s3/src/endpoint.ts:17-108`).
- Scrypt verification always runs against a fixed dummy hash for unknown users
  (`apps/api/src/auth/service.ts:19-82`).
- Refresh tokens are random, hashed at rest, rotated transactionally, and
  stored in HttpOnly, SameSite=Lax cookies. Refresh/logout require a
  constant-time CSRF cookie/header match (`apps/api/src/auth/cookies.ts:16-94`).
- API credential secrets are high-entropy, SHA-256 hashed only, and checked with
  constant-time comparison; tenant/namespace/status/expiry checks are present
  (`apps/api/src/auth/api-credential.ts:47-103`).
- Provider credentials are encrypted with AES-256-GCM and a wrapped data key;
  plaintext credential columns are absent from the schema.
- Storage object keys, namespace slugs, list prefixes, UUID route parameters,
  and request bodies are bounded and validated. Prisma queries consistently
  include organization/namespace scope in reviewed paths.
- Node request/header/keep-alive timeouts and a bounded request ID are set
  (`apps/api/src/server.ts:178-186`, `apps/api/src/security/request-id.ts:3-6`).
- Auth access sessions are revocable after logout through persisted session IDs;
  Redis-backed rate limits, bounded gateway backpressure, upload concurrency
  caps, terminal-session pruning, and multipart recovery are covered by the
  current implementation.
- Usage counters are organization/namespace scoped, non-negative at the
  database boundary, and exposed through a permission-guarded paginated API;
  CSV export avoids unbounded response pages.
- Migration failure state stores stable error codes rather than raw provider
  messages or URLs; source fingerprints and per-provider copy limits prevent
  stale cutovers and backend overload (`apps/worker/src/migration-reconciliation.ts`).
- The API and admin UI emit explicit CSP/HSTS headers; object downloads use
  attachment disposition and content-type metadata rejects control characters.
- The API returns generic 404, JSON-parse, and internal-error responses without
  stack traces (`apps/api/src/app.ts:95-111`).

## Validation performed

- `npm audit --audit-level=high`: **0 vulnerabilities**.
- `npm test`: **178 tests passed** (API 121, worker 34, auth 4, provider-s3 16,
  storage-core 3).
- `npm run typecheck`: passed for all workspaces.
- `npm run build`: passed, including the Next.js production build.
- `npm run db:test`: passed tenant-boundary, audit-log, multipart, and
  encrypted-credential checks.
- `npm run db:generate`, `npm run db:deploy`, and `npm run db:test`: passed; the
  usage-metering, migration-fingerprint, upload-overwrite, migration-state,
  migration-concurrency, platform-settings, and proxied-transfer migrations were
  applied to the configured PostgreSQL database.

## Production follow-up checklist

1. Close the remaining SSRF residual with a controlled egress connector and
   explicit redirect policy; keep the per-socket lookup guard.
2. Configure `MOSP_REDIS_URL` for every production API instance and monitor
   limiter/cleanup errors.
3. Configure `MOSP_METRICS_TOKEN` through a secret manager and scrape metrics
   only from the private monitoring network.
4. Verify CSP/HSTS and TLS behavior in deployment smoke tests, and select a
   supported stable Next.js release before production exposure; the current
   dependency is `next@16.3.0-canary.104`.
5. Capacity-test the bounded proxy path against the deployment reverse proxy;
   keep provider buckets private and retain the 300-second/1 GiB hard ceilings
   until measured capacity justifies a reviewed code change.

## P3 hardening pass

The final code-level hardening pass added `Cache-Control: no-store` to API,
storage, health, readiness, and metrics responses; bounded worker shutdown that
drains an active reconciliation for at most 30 seconds; and the fail-closed
`npm run production:config:check` preflight. Aggregate Prometheus alert rules,
a Grafana dashboard, and the release evidence checklist are checked in under
`project-docs/observability/` and `project-docs/p3-production-gate.md`.

The remaining P3 items are intentionally deployment gates rather than hidden
application assumptions: managed Redis HA, PostgreSQL PITR and disposable
restore evidence, egress/redirect enforcement, KMS/HSM integration, TLS/load
balancer verification, provider IAM, and live provider contract evidence.
