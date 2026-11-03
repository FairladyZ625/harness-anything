# PostgreSQL daemon deployment

The Harness daemon remains the central service. Configure its storage at the daemon
composition boundary; GUI, CLI and thin application services use its existing RPC
ports. Applications do not embed a RepoCell or write Harness SQL tables.

SQLite remains the default when a repository has no entry in
`<daemon-user-root>/daemon-storage.json`. An explicit PostgreSQL entry never falls
back to a local SQLite ledger, projection, writer-epoch database or replication-slot
database.

```json
{
  "repository-id": {
    "backend": "postgres",
    "connectionString": "postgresql://harness_runtime:REDACTED@database/harness",
    "authorityConnectionString": "postgresql://harness_authority:REDACTED@database/harness",
    "scope": {
      "tenantId": "tenant-id",
      "projectId": "project-id",
      "policyEpoch": 1,
      "readers": ["person-id"]
    },
    "materialize": false
  }
}
```

The key is the registered repository ID. Protect this deployment file as a secret:
both connection strings are passed to the daemon's worker, never to agents or
writer-fence descriptors. Runtime connections must use a non-owner role without
superuser or `BYPASSRLS`. Provision schema ownership, runtime grants and repository
writer authority through the existing [storage migration tooling](storage-migration.md).
The authority connection controls the repository-wide writer epoch and migration
fence; do not give that capability to an agent. Authorization still passes through
the configured `AuthorizationProvider`; database scope is not a substitute for
human and node permission checks.

## Attach and switch authority

Create or migrate the target schema before attaching the repository. Follow the
freeze, export, import and verification protocol in
[storage-migration.md](storage-migration.md). A production backend change requires
the deployment owner's approval. Changing this JSON file is not a migration or a
rollback: an old SQLite authority cannot be resumed after PG has accepted writes.
A rollback requires a frozen, verified reverse export.

Install the configuration before registering or opening the repository. Repository
registration records a null authored branch when Git following is unconfigured.
An invalid explicit scope or incomplete connection configuration refuses startup.
Opening a newer daemon writer acquires a higher PG epoch and fences the previous
writer, including its filesystem and Git follower effects. Nodes continue to claim
tasks through the center queue and the existing task occupancy/lease contract.

## Files and optional Git following

Every agent node retains the complete authored `harness/` tree. The existing fleet
base-backup, generation, WAL receiver and mirror machinery supplies it; agents can
grep it and submit changes through RPC. PostgreSQL stores canonical events, content
objects and cuts. It does not store Git history or provide a filesystem mount.

The center can set `materialize: false` when it only serves RPC and fleet replicas.
Keep materialization enabled (the default) when agents run at the center or when
center-side filesystem operations need the authored tree. Agent execution requires
a real workspace on its execution node.

Git following is an independent option on the same configuration:

```json
"gitFollower": { "branch": "main" }
```

Provide an initialized ledger Git repository and its normal VCS configuration when
enabling it. Publication uses the existing VCS port. Without this option, canonical
events, authored paths, replication and submission routes remain the same; Git
receipts have no commit SHA. Artifact tasks can submit and complete without Git.
Repository-diff tasks still require their ordinary Git delivery commit. There is
no separate PG-only task lifecycle and no `openPgRepoCell` entrypoint.

## Edge upgrades, recovery and permission changes

Base-backup archive schema `fleet-basebackup/v3` supports the same receiver for both
backends. A PG center exports a consistent canonical seed plus content objects;
only the receiving edge hydrates its disposable SQLite replica and common
projection. A SQLite center retains the existing database-copy backup. Existing v2
cache pointers are discarded and resnapshotted; no authoritative ledger conversion
is needed for this disposable cache change.

Durable PG replication slots retain the existing session and ACK fences. A restarted
or disconnected node resumes at its accepted position, or receives a new backup if
retention has passed it. Stream admission and each page check the node owner's
current repository-read permission. Revocation withdraws the replica generation and
all mirror-owned authored files, including locally edited copies; re-grant permits
normal resnapshot. Submit local candidates before removing a node's read grant if
they must be retained.

Use real PostgreSQL evidence for deployment readiness. PGlite is a test adapter,
available only on the supported Node runtime; it does not establish PostgreSQL RLS,
role, lock or multi-node deployment behavior. No production storage switch is
performed by this change.
