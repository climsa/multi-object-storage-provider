# Local development secrets

Provide the connection string for your existing PostgreSQL instance in
`database-url` before running `npm run secrets:init` from the repository root.
The initializer creates only:

- `auth-signing-key`: local-only JWT signing key.
- `provider-kek`: local-only key-encryption key used to wrap provider data keys.

The generated files are ignored by Git. Never copy production credentials or a
production KMS key into this directory.

Provider endpoint network policy is intentionally separate from secrets. For a
local HTTP/private S3-compatible target, explicitly set
`MOSP_PROVIDER_ALLOW_HTTP=true`,
`MOSP_PROVIDER_ALLOW_PRIVATE_NETWORK=true`, and include its port in
`MOSP_PROVIDER_ALLOWED_PORTS` (for example `80,443,9000`). These flags do not
contain provider credentials and default to the safer public HTTPS/443 policy.

If the API is deployed behind a reverse proxy, set the non-secret policy flag
`MOSP_TRUST_PROXY_HOPS` to the exact number of trusted proxy hops. Leaving it
unset keeps Express from trusting forwarded client IP/protocol headers.
