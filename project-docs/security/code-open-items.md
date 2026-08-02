# Code-open items

These items are deliberately tracked separately from completed security fixes.
They require a separate design or an external integration before they should be
enabled.

## Proxy transfer residual controls

`PROXIED` upload and download are implemented through the API gateway. The
gateway requires an exact `Content-Length`, streams with provider backpressure,
uses a configurable operation timeout bounded to 10–300 seconds, caps each
proxied object at a configurable size bounded to 1 GiB, and
cleans up the provider object plus quota reservation on failure. Proxy egress
is metered from bytes actually delivered; direct egress remains an estimate
based on the indexed object size.

Before production enablement, capacity-test the selected timeout and size
against the selected gateway/reverse-proxy limits, and confirm network egress
controls and provider IAM are enforced outside the application.

## Provider compatibility gate

The repository includes an opt-in S3-compatible provider contract test, but it
does not run without explicit provider credentials. Run it for every supported
addressing mode before a release that changes provider adapters.

## Deployment controls

Network egress/redirect policy, KMS/HSM key storage, managed Redis, TLS
termination, object-store IAM, backups, and secret rotation remain deployment
responsibilities. They are tracked in
[`deployment-only-controls.md`](deployment-only-controls.md).
The repository-side production contract is checked by
`npm run production:config:check`; monitoring rules and the release evidence
sequence are in `project-docs/observability/` and
`project-docs/p3-production-gate.md`.

## Platform settings boundary

Global platform settings are stored as an allowlisted, versioned, audited
control-plane registry and are applied by the API/worker on their next process
start. Deployment secrets and network controls remain outside the registry:
database/Redis URLs, JWT and provider KEKs, metrics tokens, TLS, proxy trust,
egress firewall, and private-network exceptions must stay in the deployment
secret/runtime layer.
