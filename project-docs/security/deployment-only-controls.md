# Deployment-only security controls

These controls cannot be completed reliably in application code alone. They
must be configured and verified in the runtime platform before production
exposure.

## Network egress and provider redirects

- Run API and worker workloads behind an egress firewall or proxy.
- Allow only approved provider destinations and required ports, normally HTTPS
  443. Deny loopback, RFC1918, link-local/metadata (`169.254.169.254`),
  multicast, and reserved ranges.
- Resolve and validate every connection at the egress boundary so DNS
  rebinding cannot bypass the application check.
- Do not enable `MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK=true` globally. Private
  MinIO or customer-hosted storage requires an explicit per-provider connector
  or tunnel with an allowlist.
- Reject HTTP 3xx redirects at the egress boundary, or permit only redirects
  whose destination is revalidated against the same provider allowlist. Never
  follow a redirect to an unapproved or private destination.

## Secrets and cryptographic key management

- Replace the local file key provider with KMS/HSM-backed key encryption.
- Supply database URLs, Redis credentials, JWT signing keys, provider KEKs,
  and `MOSP_METRICS_TOKEN` through a secret manager. Do not place them in image
  layers, source control, or ordinary environment dumps.
- Define rotation, revocation, backup, and incident-response procedures for
  JWT signing keys, provider credentials, and the provider KEK.
- For KEK rotation, use a KMS/HSM key-version policy with an auditable migration
  count. Keep old versions decrypt-only until re-encryption verification and
  rollback evidence are complete; do not delete the old version immediately.

## TLS, proxy, and trust boundaries

- Terminate TLS at a managed edge or load balancer and enforce HTTPS before
  enabling HSTS.
- Set `MOSP_TRUST_PROXY_HOPS` to the actual fixed proxy chain; do not trust
  arbitrary forwarded headers.
- Restrict `/metrics` to the private monitoring network and use the required
  metrics token.
- Configure Redis for every production API replica so rate limits are shared;
  alert on Redis failures and readiness degradation.
- Configure the load balancer to stop routing to a replica after `/readyz`
  returns 503, and allow the API's 30-second graceful drain before terminating
  the process during rolling deployment.
- Capacity-test `MOSP_STORAGE_MAX_IN_FLIGHT` and keep the value below the point
  where provider connections or database pools become saturated. The API
  rejects excess storage work with `503 storage_overloaded`.

## Release verification

- Run `npm run production:config:check` in the production deployment context.
  It validates the required Redis, metrics, origin, proxy-hop, provider-network,
  and bounded-limit settings without printing secret values or connecting to a
  service.
- Use a stable, supported Next.js release rather than a canary build.
- Run deployment smoke tests for CSP nonce headers, HSTS, provider egress,
  redirect rejection, `/readyz`, and `/metrics` access.
- Run the live S3-compatible provider contract test against each supported
  addressing mode before release. The repository intentionally does not run
  this test without explicit provider credentials.
