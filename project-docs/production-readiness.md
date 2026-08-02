# Production readiness checklist

The application gates below are implemented in code; deployment controls remain
the operator's responsibility.

Detailed controls that cannot be enforced by repository code are tracked in
[`security/deployment-only-controls.md`](security/deployment-only-controls.md).
The complete release sequence and evidence checklist is in
[`p3-production-gate.md`](p3-production-gate.md), with importable monitoring
rules in [`observability/`](observability/).

## Required deployment controls

- Run `npm run production:config:check` in the production runtime context before
  deployment. It validates required Redis/metrics/origin/proxy settings and
  provider-network defaults without printing secret values.
- Apply checked-in migrations with `npm run db:deploy` before starting API or
  worker processes. Never run `prisma migrate dev` against a shared database.
- Supply `MOSP_REDIS_URL` to every API instance. Production startup fails closed
  without it so rate limits are shared across replicas.
- Treat Redis as a hard readiness dependency. A runtime Redis failure must return
  `503 dependency_unavailable` from protected routes; never switch a production
  replica to an in-memory limiter. Drain a replica only after `/readyz` is 503.
- Set `MOSP_STORAGE_MAX_IN_FLIGHT` and
  `MOSP_MIGRATION_MAX_CONCURRENT_PER_PROVIDER` as safe fallbacks when no
  platform setting has been stored. Global Admin values are validated, applied
  on the next API/worker restart, and must also be capacity-tested before use.
  Saturated storage requests are rejected with `503 storage_overloaded` instead
  of accumulating an unbounded gateway queue.
- Review the Global Admin proxy settings before enabling `PROXIED` namespaces:
  `proxy_max_object_size_bytes` accepts 1 byte through 1 GiB and
  `proxy_transfer_timeout_seconds` accepts 10 through 300 seconds. Both are
  applied after API restart and must remain within the reverse proxy's tested
  request limits.
- Review the organization usage endpoint and CSV export as a bounded billing
  input. Direct-transfer egress is an estimate based on successful presign;
  proxied egress is counted from bytes delivered. Both must be reconciled with
  provider billing before charging customers.
- Supply `MOSP_METRICS_TOKEN` through a secret manager. `/metrics` is 404 when
  disabled or when the token is wrong; scrape it over the private network.
- Keep `MOSP_PROVIDER_ALLOW_HTTP=false` and
  `MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK=false` unless an approved connector
  requires an explicit exception. Enforce egress deny rules at the network edge.
- Replace the local file key provider with KMS/HSM-backed key encryption before
  production. Rotate the KEK and provider credentials under an incident-tested
  procedure.
- During KEK rotation, keep the previous key version available for decrypt-only
  access until every provider envelope has been re-encrypted and verified under
  the new version. The local provider supports this test workflow, but it is not
  a production KMS replacement.
- Run the provider credential key-rotation tool in dry-run mode first and retain
  its version counts as release evidence. Do not use apply mode until the API
  and worker can read both key versions during the migration window.
- Terminate TLS before the API/web origin, preserve the configured proxy hop
  count, and use private object-storage origins with attachment responses.
- For rolling deployment, send `SIGTERM`, wait for readiness to become 503, then
  allow up to 30 seconds for active requests to drain. The API closes remaining
  connections after that bounded grace period and disconnects Redis/PostgreSQL
  afterward.
- Capacity-test proxied transfers against the reverse proxy's body-size and
  timeout limits. The application retains hard ceilings of 1 GiB and 300
  seconds; do not raise either ceiling without a reviewed capacity and cost
  change.
- Record a baseline with `npm run capacity:proxy` in staging at the intended
  concurrency and payload size. Compare p95 latency, failed operations, API
  in-flight saturation, and provider-side bandwidth before enabling proxy mode
  for a customer cohort.
- Run `npm run soak:proxy` during a staging soak window. Keep the failure budget
  at zero for release evidence; investigate HTTP 429, provider 5xx, and timeout
  failures separately before changing limits.
- Validate a PostgreSQL custom-format backup with `npm run db:backup:verify` and
  rehearse restore only against a separately provisioned disposable target. The
  repository never restores over the active database.
- During Redis maintenance, drain API replicas through `/readyz`, verify Redis
  recovery with `npm run redis:probe`, then return traffic only after
  `npm run readiness:probe -- --expect ready` is stable.

## Data protection and recovery

- Back up PostgreSQL with point-in-time recovery and test a restore at least
  monthly. The database contains object metadata, tenant policy, audit history,
  encrypted provider credentials, and migration state; object bytes remain in
  the provider buckets.
- Retain provider bucket versioning/soft-delete according to the organization's
  recovery policy. API deletion is a logical metadata transition followed by a
  provider delete; `DELETING` and `RETAINED` states are retryable by the worker.
- Before a destructive provider or namespace operation, confirm an export of
  the metadata database and record the operator/audit request ID.

## Runtime signals

Alert on:

- `/readyz` returning 503 for more than two worker intervals.
- Non-zero `failed` counts from upload or migration reconciliation.
- Migration runs stuck in `COPYING` beyond 15 minutes or growing `FAILED` items.
- Provider health becoming `UNHEALTHY` or placement returning no eligible target.
- Provider recovery must be demonstrated by a subsequent successful health
  reconciliation that changes the status back to `HEALTHY`; an outage-only
  result is not sufficient release evidence.
- `mosp_storage_overloaded_total` increasing or
  `mosp_storage_in_flight` remaining at its configured ceiling.
- `mosp_proxy_upload_failures_total` or `mosp_proxy_download_failures_total`
  increasing; compare the corresponding `*_bytes_total` and
  `*_duration_seconds` series with the capacity baseline. These metrics are
  aggregate counters only and contain no tenant, credential, or object-key
  labels.
- Redis connection errors, repeated 429 responses, and rising provider 5xx.
- `/readyz` remaining 503 after Redis recovery; verify Redis ping and database
  connectivity before returning the replica to service.

The current worker processes bounded batches (100 upload lifecycle records and
20 migration items per pass) and uses explicit state guards to make retries
safe. Provider outage handling is covered by the API and worker test suites;
live provider compatibility testing remains an opt-in pre-release gate and is
intentionally skipped in the current development pass.

Migration copies capture the source ETag/last-modified fingerprint at planning
time, verify it before and after the provider copy, and delete an uncommitted
target candidate if the source changes. This prevents a stale copy from being
cut over to the logical object index.
