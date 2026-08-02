# Provider credential key rotation runbook

The rotation tool is dry-run by default and never prints provider credentials or
key material. It inventories envelope versions and can re-encrypt records in
bounded batches only after an explicit confirmation token.

## Dry-run inventory

Use the current key and version to confirm the current envelope distribution:

```bash
npm run provider:key-rotation -- \
  --current-key-file .local/secrets/provider-kek \
  --current-key-version local-v1
```

The output contains only counts. The current key file and every previous key file
must be mode 600.

## Re-encryption prerequisites

Before applying a rotation, deploy runtime support for the new key version and
keep the old key available for decrypt-only access. The current local API/worker
configuration uses one key file, so the apply mode must not be used for a live
deployment until dual-version runtime wiring or a KMS/HSM integration is in
place.

For a controlled migration, provide the new key file and each old version:

```bash
npm run provider:key-rotation -- \
  --current-key-file .local/secrets/provider-kek-v2 \
  --current-key-version local-v2 \
  --previous-key local-v1=.local/secrets/provider-kek \
  --batch-size 25 \
  --apply ROTATE_PROVIDER_KEYS
```

The command uses optimistic key-version guards, so a concurrent credential
rotation is counted as a conflict instead of being overwritten. Stop and
investigate any non-zero failure count before retiring the previous key.

Production must use KMS/HSM key versions, audit the migrated/remaining counts,
and retain a rollback window. The local file provider is only a development and
verification implementation.
