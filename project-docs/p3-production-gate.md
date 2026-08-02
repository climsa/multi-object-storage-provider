# P3 production-beta gate

P0–P2 application work is complete. P3 is the final production-beta hardening
gate: the repository now contains the preflight, observability rules, recovery
runbooks, and bounded transfer checks. A release is **not** production-ready
until the deployment-only controls below have evidence attached to the release.

## Repository checks

Run from the repository root:

```bash
npm run quality:check
npm run build
npm run db:backup:verify
npm run provider:key-rotation -- --current-key-file <secret-file> --current-key-version <version>
npm run production:config:check
```

`production:config:check` reads runtime variables only, never prints their
values, and never connects to a service. It requires production-safe Redis,
metrics, origin, proxy, provider-network, and bounded-limit settings.

For a staging provider, also run:

```bash
npm run e2e:minio
npm run capacity:proxy
npm run soak:proxy
npm run redis:probe -- --url <staging-redis-url>
npm run readiness:probe -- --url <api-readyz-url> --attempts 3 --expect ready
```

## Deployment evidence required

- Managed Redis is configured for every API replica, with HA/failover evidence.
- PostgreSQL PITR/retention policy is enabled; a monthly restore rehearsal was
  completed against a separate disposable target.
- Provider traffic exits through an egress firewall/proxy that blocks private,
  metadata, loopback, multicast, and reserved ranges and revalidates redirects.
- Provider IAM/bucket policy is private and least-privilege; credentials are
  delivered by a secret manager.
- A KMS/HSM-backed `KeyEncryptionKeyProvider` is selected. The local file key
  provider is development-only and must not be used for production data.
- TLS termination, fixed proxy-hop count, HSTS, `/metrics` private access, and
  load-balancer drain behavior were verified with deployment smoke tests.
- The proxy capacity baseline and zero-failure soak report are attached.
- The checked-in Prometheus alerts and Grafana dashboard are installed and an
  on-call owner has acknowledged a test alert and its recovery.
- The live S3-compatible provider contract test passed for every supported
  addressing mode using disposable test data.

If any item lacks evidence, keep the release in beta/staging. The repository
does not create PostgreSQL, Redis HA, KMS/HSM, firewalls, load balancers, or
production buckets on the operator's behalf.
