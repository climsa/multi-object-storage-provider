# Backup, restore, and Redis recovery runbook

## PostgreSQL backup validation

Run the non-destructive archive check from the repository root:

```bash
npm run db:backup:verify
```

The command reads `.local/secrets/database-url`, requires that file to be mode
600, creates a mode-600 custom-format archive in a mode-700 temporary directory,
and validates it with `pg_restore --list`. The temporary archive is removed after
the check. It never writes to PostgreSQL and never prints the connection string.
The PostgreSQL client tools (`pg_dump` and `pg_restore`) must be installed on
the operator workstation or CI runner.

## Restore rehearsal

Restore testing must use a separately provisioned disposable PostgreSQL target.
Do not point a restore command at the active application database. Provision the
target with the same PostgreSQL major version, restore the validated archive with
the operator's secret-file-based connection method, then run:

```bash
npm run db:validate
npm run db:test
```

The repository also provides a guarded restore command. The target secret file
must be mode 600, its database name must end in `_restore` or `-restore`, and
the confirmation token is mandatory:

```bash
npm run db:restore:verify -- \
  --archive /secure/path/metadata.dump \
  --target-secret-file .local/secrets/disposable-restore-url \
  --confirm-disposable RESTORE_DISPOSABLE_DATABASE
```

It validates the archive first, then runs `pg_restore --clean --if-exists` only
against the explicitly named disposable target. It never creates a PostgreSQL
server or database.

Record the archive timestamp, target identifier, migration version, row counts,
and validation result. The repository does not create a PostgreSQL instance or
automatically run a destructive restore.

## Redis recovery probe

Validate an available Redis endpoint with an ephemeral key that is deleted before
the command exits:

```bash
npm run redis:probe
```

Validate the expected unavailable state against a disposable or stopped port
without logging credentials:

```bash
npm run redis:probe -- --url redis://127.0.0.1:6399 --expect unavailable
```

For a production Redis restart or failover, first remove the API instance from
the load balancer, confirm `/readyz` is 503 during the dependency outage, restart
or fail over Redis using the platform procedure, and run `npm run redis:probe`
followed by `npm run readiness:probe -- --expect ready`. Restore traffic only
after readiness is stable. The probe never restarts Redis itself.
