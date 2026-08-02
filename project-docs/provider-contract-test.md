# Provider contract test

The repository can test an existing S3-compatible object storage target without
creating PostgreSQL, MinIO, or another provider. The test is opt-in and reads
credentials from the ignored file `.local/secrets/provider-test.json`.

Create the file with this shape and set restrictive permissions:

```json
{
  "endpoint": "https://storage.example.com",
  "region": "us-east-1",
  "addressingMode": "PATH_STYLE",
  "bucket": "mosp-contract-tests",
  "accessKeyId": "replace-me",
  "secretAccessKey": "replace-me"
}
```

For a local/private S3-compatible endpoint, explicitly add `allowHttp: true`,
`allowPrivateNetwork: true`, and an `allowedPorts` list. The runtime lookup
guard remains enabled; the private-network bypass is an explicit test-only
choice in this file.

Run the basic capability and object contract:

```bash
chmod 600 .local/secrets/provider-test.json
npm run provider:contract-test
```

The basic contract validates provider capability probing plus presigned PUT,
HEAD, presigned GET, and cleanup. To additionally upload two multipart parts,
complete the upload, verify the final size, and clean it up:

```bash
npm run provider:contract-test -- --multipart
```

The test key is generated below `.mosp-contract-tests/` and is deleted in the
cleanup path. Do not use a bucket containing unrelated production data.

## API + MinIO smoke test

After the API and MinIO are running, the repeatable control-plane smoke test
can be run with:

```bash
npm run e2e:minio
```

Create `.local/secrets/e2e-test.json` with mode `0600`:

```json
{
  "apiBaseUrl": "http://127.0.0.1:4000",
  "adminEmail": "e2e@example.test",
  "adminPassword": "<local-admin-password>",
  "organizationId": "<optional-organization-uuid>",
  "namespaceId": "<optional-namespace-uuid>",
  "providerId": "<optional-provider-uuid>"
}
```

The script creates a temporary API credential and prefix grant, runs
initiate/upload/complete/list/HEAD/download/delete for both direct and proxied
transfers, verifies that a revoked credential is rejected, and cleans up the
grant and credential. It never writes provider or API secrets to logs.

## Proxy capacity baseline

For a bounded local/staging baseline, run the proxy-only concurrent test after
the API and MinIO/provider are running:

```bash
npm run capacity:proxy
```

Defaults are four concurrent objects, two iterations, and a 64 KiB payload.
Each object uses four storage API requests (initiate, upload, download, delete),
so the default eight operations stay below the local 60-request/minute storage
rate limit. Increase concurrency only after accounting for that limiter.
The test accepts bounded overrides for controlled experiments:

```bash
npm run capacity:proxy -- --concurrency 8 --iterations 3 --payload-bytes 1048576
```

It reports completed operations and p50/p95/max end-to-end latency, then
restores the namespace transfer mode and removes temporary objects, grant, and
credential. A run that exceeds the configured storage request rate limit is
reported as a failed capacity result (typically HTTP 429), which is useful when
choosing a realistic concurrency/iteration baseline. Run it only against a
disposable or explicitly approved target; the script intentionally does not
change the hard proxy ceilings.

For a bounded soak run, use the same harness with a time window. The duration is
limited to five minutes and the default failure budget is zero, so rate-limit or
provider failures fail the run instead of being hidden:

```bash
npm run soak:proxy
npm run capacity:proxy -- --duration-seconds 120 --concurrency 2 --max-failures 0
```

The report includes the number of completed iterations, failures, latency
percentiles, and sanitized failure reasons. Configure the target rate limit
before increasing concurrency; do not treat a run that is mostly HTTP 429 as a
provider-capacity result.
