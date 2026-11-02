# Cold storage migration

`ha migrate storage` transfers a complete canonical ledger between SQLite, PostgreSQL and PGlite. It runs as a host-local administrator Action on the repository writer queue. PGlite requires Node.js 26 or newer; Node.js 24 returns `pglite_runtime_unsupported` before opening WASM.

Prepare source and target JSON location files. Protect connection credentials with local file permissions. A PostgreSQL target must already have the event-ledger and projection schemas for this release. Use its primary endpoint and a management login able to install migration policies, create temporary logins, create a transaction-scoped replay schema and grant read access. Runtime credentials are insufficient. Git history remains in Git.

```json
{
  "rootDir": "/absolute/source-workspace",
  "storage": {
    "backend": "sqlite",
    "scope": { "tenantId": "local", "projectId": "project", "readers": [], "policyEpoch": 0 }
  }
}
```

```json
{
  "storage": {
    "backend": "postgres",
    "connectionString": "postgresql://management@localhost/target",
    "scope": { "tenantId": "local", "projectId": "project", "readers": [], "policyEpoch": 0 }
  }
}
```

For PGlite use `backend: "pglite"`, an absolute `dataDir`, and the same scope. SQLite destinations must be new workspace generations; keep each former authority and its export directory. Do not use an active PGlite data directory from a second process.

```sh
ha migrate storage --from sqlite --to postgres \
  --source source.json --target target.json --run-id switch-001 \
  --export-directory /absolute/retained-export --mode preflight

ha migrate storage --from sqlite --to postgres \
  --source source.json --target target.json --run-id switch-001 \
  --export-directory /absolute/retained-export --mode migrate
```

The command refuses in-flight runtimes and unreleased execution leases. It takes a new writer epoch, writes a durable freeze, retains `manifest.json`, prepares and imports the target, compares event and blob bytes, digests, timestamps, command outcomes, final headDigest and deterministic projection rows. The projection witness includes complete task aggregates, documents, entity values and freshness, facts, decisions and relations. The manifest binds supported event-schema, reducer and projection versions. Unsupported historical versions fail through the canonical reader.

PostgreSQL export uses a temporary read-only login with no role memberships or BYPASSRLS. Its RLS scope comes from an expiring management-written grant keyed by `session_user`. Changing transaction-local tenant/project claims or a run id cannot choose another scope. Normal completion drops the login, policies and grant. After an exporter process crash, grant expiry immediately denies reads; the next migration management entry removes expired logins and policies.

The durable order is `prepared` → `source_sealed` → target activation marker. Marker persistence transfers authority. Source and target refuse ordinary append while frozen or prepared, including append with a higher epoch. After the marker the old source stays read-only. The command never edits production configuration; after a successful receipt, the operator selects the activated backend and starts a writer with a fresh epoch. Production cutover still requires the operator's authorization.

A destination uses a new replication history. Existing edge cursors must perform a full snapshot rebuild; do not copy old replication positions or acknowledgements to the destination.

## Recovery

Use the same location files, run id and export directory with `--mode resume`. Recovery reads the target marker before source state. Unreadable or inconsistent sides fail closed. Interrupted imports resume idempotently and must pass the same complete reconciliation before activation.

If activation fails, `activation_failed` persists and the source stays read-only. Resume retries activation. Before any target marker exists, `--mode abort` abandons the target and records a source unseal with a newer writer epoch. Reopen the source writer so it acquires that epoch. An interrupted abort can be repeated. A lost marker acknowledgement may return an error even though the marker committed; resume resolves that state from storage.

After a target marker exists, abort refuses. Roll back by a new full reverse migration into a new empty destination, including writes accepted since cutover. Pointing configuration at the old source cannot restore write authority.

PostgreSQL → SQLite refuses multiple tenant/project tuples, any nonempty `readers`, and enforced nonzero `policy_epoch`. There is no lossy override flag. Preserve the source and obtain an explicit scope or authorization redesign before attempting such a downgrade.
