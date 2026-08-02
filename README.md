# Multi-Provider Object Storage

Database-first scaffold for the multi-tenant object-storage control plane and
data gateway described in [`project-docs/PLAN.md`](project-docs/PLAN.md).

## Current foundation

- npm workspaces with separate web, API, and worker runtimes.
- PostgreSQL metadata store through Prisma ORM.
- Organization-scoped RBAC and append-only activity-log schema.
- Provider, capability, bucket, and encrypted provider-credential schema.
- Virtual namespace, placement policy, and tenant-safe placement-target schema.
- Tenant-scoped namespace CRUD and placement-policy target endpoints with audit logs.
- API credential create/list/rotate/revoke lifecycle with one-time secrets and hash-only storage.
- Folder-grant CRUD and boundary-aware prefix authorization for roles and API credentials.
- JWT access tokens with rotated httpOnly refresh cookies and CSRF checks.
- Provider connection create/list/test flow with S3-compatible endpoint validation
  and capability probing.
- Bucket discovery and import flow with organization-scoped access checks.
- Envelope encryption boundary; provider credentials are never sourced from an
  environment variable.
- Redis development service for the later queue and coordination layer. PostgreSQL
  is intentionally external; this repository does not create a database instance.
- Worker reconciliation for expired direct uploads: provider deletion succeeds
  before quota reservations are released, and provider failures remain retryable.
- Multipart upload contracts for objects at least 64 MiB, including part URL
  signing, persisted part metadata, provider completion, and abort cleanup.
- Object lifecycle cleanup: authenticated object delete, explicit overwrite opt-in,
  retained-location cleanup, quota reconciliation, and audit events.
- Capacity-aware placement: healthy-provider filtering, priority tiers, weighted
  selection, per-target threshold checks, and in-flight reservation accounting.
- Admin dashboard at the web root with memory-only access tokens, organization
  scope selection, provider/bucket/namespace views, and recent audit events.
- Bounded cross-provider migration runs with pause/cancel controls, streaming copy,
  destination verification, atomic location switch, retry state, and audit logs.
- Protected Prometheus-style metrics at `/metrics` when `MOSP_METRICS_TOKEN` is
  configured; readiness checks PostgreSQL and Redis when Redis is enabled.
- Bounded storage-gateway backpressure rejects excess in-flight work with a
  retryable `503` instead of allowing an unbounded request queue.
- Organization-scoped usage API and bounded CSV export with namespace quota,
  object, request, ingress, and estimated egress counters.

The database-backed provider connection flow is available. Live compatibility
tests still require the disposable S3-compatible target supplied for testing;
MinIO is not created by this repository.

The opt-in provider contract harness is documented in
[`project-docs/provider-contract-test.md`](project-docs/provider-contract-test.md).
It reads `.local/secrets/provider-test.json`, never stores provider credentials
in the repository or a `.env` file, and cleans its generated test objects.

The initial API contract is maintained in
[`project-docs/openapi.yaml`](project-docs/openapi.yaml). It describes the
implemented auth, organization, membership, role, provider, bucket, namespace,
credential, grant, storage, and migration vertical slices.

Operational deployment checks and backup/restore expectations are listed in
[`project-docs/production-readiness.md`](project-docs/production-readiness.md).
The P3 production-beta release gate and evidence checklist is in
[`project-docs/p3-production-gate.md`](project-docs/p3-production-gate.md),
including importable Prometheus/Grafana observability artifacts.
The operator runbook for PostgreSQL archive validation and Redis recovery is in
[`project-docs/backup-restore-runbook.md`](project-docs/backup-restore-runbook.md).
Provider credential key-version rotation guidance is in
[`project-docs/key-rotation-runbook.md`](project-docs/key-rotation-runbook.md).

Run `npm run openapi:check` to verify the documented route inventory and
component references without adding a runtime YAML dependency.

Product API credentials use `Authorization: Bearer <keyId>.<secret>`. The
secret is verified against its database hash, checked for active status and
expiry, and never returned by list or revoke responses. Management endpoints
continue to use the user JWT flow.

The storage boundary exposes metadata listing/HEAD plus direct, multipart, and
proxied object operations. Direct downloads redirect to a short-lived provider
URL after the read grant is checked; a `PROXIED` namespace streams the object
through the API and meters bytes delivered. `POST /storage/v1/:namespace/uploads`
reserves namespace quota and returns either a presigned PUT URL, a multipart
contract for objects at least 64 MiB, or a provider-isolated proxied upload
session. Proxied uploads use `PUT /storage/v1/uploads/:uploadId` with an exact
`Content-Length`; the gateway enforces the Global Admin proxy size/timeout
settings, with hard ceilings of 1 GiB and 300 seconds. Multipart clients request each part URL through
`POST /storage/v1/uploads/:uploadId/parts/:partNumber`, then submit part ETags
and sizes to `POST /storage/v1/uploads/:uploadId/complete`. The provider object
is verified before its metadata becomes available.
`DELETE /storage/v1/uploads/:uploadId` releases an unfinished reservation. All
storage routes require an API credential, match its namespace, and enforce
FolderGrant permissions.

## Local setup

1. Put the connection string for your existing PostgreSQL instance in
   `.local/secrets/database-url`.
2. Run:

   ```bash
   npm install
   npm run secrets:init
   npm run infra:up
   npm run db:generate
   npm run db:validate
   npm run bootstrap:local
   npm run typecheck
   npm test
   ```

`npm run infra:up` starts Redis only. Apply the checked-in migrations against
the PostgreSQL instance you provide with:

```bash
npm exec --workspace @mosp/db prisma migrate deploy
```

The same non-interactive operation is available as `npm run db:deploy`. It is
preferred for a running shared PostgreSQL instance; `db:migrate` is reserved for
local migration authoring and may require elevated PostgreSQL process privileges.

Redis is fail-closed when configured: if the shared limiter cannot make a safe
decision, protected requests return `503 dependency_unavailable` and are never
implicitly allowed. `/healthz` reports process liveness, while `/readyz` returns
`503` when PostgreSQL, Redis, or graceful shutdown is not ready.

For a new local schema change, create and apply a named migration with
`npm run db:migrate --workspace @mosp/db -- --name <change-name>`, then commit
the generated migration directory.

`npm run bootstrap:local` interactively creates a local admin user, an
organization, all known permissions, an Organization Owner role, and a scoped
Platform Admin role for the local control-plane. It writes only the password
hash to PostgreSQL and is intentionally not run automatically.

For a shared rate limiter, configure `MOSP_REDIS_URL`; the local Compose
service uses `redis://127.0.0.1:6379`. Production startup fails closed when
this value is absent. Local development may use the bounded in-memory fallback
when Redis is not configured.

Global administrators can manage the allowlisted runtime policy settings from
the dashboard after login. Settings are version-checked and append an audit
event; API and worker processes reload them on restart. Proxy limits are
available there as `proxy_max_object_size_bytes` (1 byte–1 GiB) and
`proxy_transfer_timeout_seconds` (10–300 seconds), with the code retaining the
1 GiB/300-second safety ceilings. Deployment secrets and network controls
remain deployment-only and are never shown in the dashboard.

The web app is pinned to `next@16.3.0-canary.104` because the current stable
release pulls vulnerable `postcss` and `sharp` versions. Re-evaluate this pin
when the next stable release includes the patched transitive dependencies.

Local secret values live in ignored files under `.local/secrets`. Production
deployments must replace the local file key provider with a KMS or secret-manager
implementation of `KeyEncryptionKeyProvider`.

Provider network policy is explicit and defaults to public HTTPS on ports 443.
For a local private S3-compatible target, opt in with
`MOSP_PROVIDER_ALLOW_HTTP=true`,
`MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK=true`, and
`MOSP_PROVIDER_ALLOWED_PORTS=80,443,9000`. These are policy flags only; provider
credentials remain request data encrypted by the API.

When the API runs behind a reverse proxy, configure the exact proxy distance
with `MOSP_TRUST_PROXY_HOPS=1` (or the actual hop count). If unset, forwarded
headers are not trusted, which is the safer default.

The worker runs upload reconciliation once at startup and every 60 seconds. The
interval can be changed with `MOSP_UPLOAD_RECONCILIATION_INTERVAL_MS` between
1,000 and 3,600,000 milliseconds.

Migration workers use the same interval and process at most 20 objects per pass.
Provider credentials and object bytes are never included in migration logs.

For production metrics, provide `MOSP_METRICS_TOKEN` through the deployment
secret manager and scrape `/metrics` with a bearer token. The endpoint returns
404 without a token and never exposes provider credentials or object keys. It
also exposes bounded gateway signals `mosp_storage_in_flight` and
`mosp_storage_overloaded_total`, plus aggregate proxy transfer counters for
attempts, successes, failures, bytes, and duration. Proxy metrics never include
tenant IDs, credential IDs, provider credentials, or object keys.

The storage gateway defaults to 100 in-flight requests. Set
`MOSP_STORAGE_MAX_IN_FLIGHT` between 1 and 10,000 after capacity testing; when
the limit is reached, new storage requests receive `503 storage_overloaded`.

Migration copies default to two concurrent items per source/target provider.
Set `MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER` between 1 and 20 after
capacity testing.

Usage is available through `usage:read` at
`/v1/organizations/:organizationId/usage` and
`/v1/organizations/:organizationId/usage/export`. Egress is counted when a
presigned download is issued using the indexed object size; it is an estimate
for direct provider transfers, not a provider billing byte receipt.
