# Fleet center user-space deployment

[English](./README.md) | **简体中文**

`centerctl.sh` is the W5-R production-cutover rehearsal deployment for
`tencent-lighthouse-prod`. It installs the pinned Node 24 tarball under the
login user's home, clones/builds Harness Anything, restores a ledger backup
into `~/harness-center/repo` and attaches it as `remote-center`, starts the
managed authorization service, generates private TLS material and the
assignment roster, and starts the daemon-owned TLS center. It never uses sudo,
Docker, system GitLab/nginx configuration, or the host's default Harness
daemon.

## Producing the backup

The center is bootstrapped from a consistent backup of the existing canonical
repository; a Git clone of the private ledger alone is not enough, because the
SQLite canonical store and its activation never enter Git. On the machine that
owns the repository today, take the backup through its daemon (the writer queue
makes the snapshot consistent) and move the directory to the center host over a
channel you trust — it carries the full private ledger:

```bash
ha backup /var/tmp/harness-center-backup   # absolute, must not exist yet
rsync -a /var/tmp/harness-center-backup tencent-lighthouse-prod:~/harness-center-backup
```

The backup is self-verifying: `up` refuses one whose manifest or payload
digests do not check out, one that carries no SQLite canonical store, and one
that belongs to a different repository id than `HARNESS_CENTER_REPO_ID`. Those
admission decisions are read from the backup's own manifest before anything is
restored, so a refused backup never leaves a half-initialized center root. A
repeated `up` does not restore again: it re-validates the recorded restore
receipt and continues from the restored repository.

First start:

```bash
ssh tencent-lighthouse-prod \
  'HARNESS_CENTER_APP_REF=<public-commit> \
   HARNESS_CENTER_BACKUP_DIR=$HOME/harness-center-backup \
   ~/harness-center/bin/centerctl.sh up'
```

`up` restores the backup into `~/harness-center/repo` (it must not already
exist), registers that root as `remote-center`, waits for the repository to
attach, rebuilds the projection to the exact restored cut, and continues with
the authorization service, TLS material, roster, and Fleet listener.

Subsequent lifecycle operations do not need the backup directory:

```bash
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh status'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh down'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh up'
```

`down` only stops this deployment's isolated daemon. It intentionally retains
the repository, TLS material, roster, and replica state for audit/recovery.
After a host reboot, log in and run `up`; the daemon and Fleet listener are
both process-owned and must be re-established.

The restored ledger carries the source machine's local Unix-socket credential,
which does not bind on the center host. The deployment does not edit
`people.yaml` and does not admit local writes to the remote center: writes
arrive from Fleet edges with node credentials, and a person signs in through
the desktop app connected to this daemon.

## Roster and nodes

`up` writes `~/harness-center/fleet/roster.json` as `fleet-roster/v3`: one
assignment row naming what the node may reach (`assignmentId`, `nodeId`,
`repoId`, `viewId`, `expiresAt`, `scope`). The roster does not say who a node
is. A node's machine credential and its owner live in the center's Keycloak
node registry, and `centerctl.sh` creates no credential and registers no node.

Before it starts the Fleet listener, `up` runs `ha bootstrap`, which installs
and starts the managed Keycloak and PostgreSQL under this deployment's user
root. That step needs no sign-in. It downloads its runtimes from
`repo1.maven.org`, `api.adoptium.net`, and `github.com`, and its receipt is
kept at `~/harness-center/rbac-bootstrap.json`.

Everything after that needs a person and is not run by the script:

1. Create the first administrator and sign in. This version offers both only
   through the desktop app connected to this daemon; a server without one has
   no entry for either (tracked as `task_8352efd2f05ab2eda87b724761`).
2. Give the node's owner an account and grant that person
   `daemon-fleet-edge-sync` on the repository.
3. Register the node, signed in as an administrator holding `access-admin`.

Keep that order: start the listener with `up` first, then sign in. Once an
administrator is signed in on this daemon, `ha daemon fleet center start` is
refused with `authorization_denied`, so a later `up` that has to start the
listener again fails at that step. This is a known limit of this version.

### Registering a node

Run these on the center, against this deployment's daemon
(`HARNESS_DAEMON_USER_ROOT=~/harness-center/user-root`,
`HARNESS_DAEMON_ID=center-rehearsal`):

```bash
mkdir -p ~/harness-center/fleet/nodes/<node-id>
ha bootstrap --operation node-register --node-id <node-id> --person-id <person-id> \
  --credential-file "$HOME/harness-center/fleet/nodes/<node-id>/credential"
ha bootstrap --operation node-list
```

The first registration of a node mints its machine credential once and writes
it to `--credential-file`, a new file readable only by its owner (`0600`). The
receipt names the file and never carries the credential. The command is
refused without `--credential-file`, and refused with
`credential_file_unavailable` when the file already exists; in both cases
nothing is registered. Use one directory per node and never share a credential
between nodes. `<node-id>` must be the `nodeId` of the roster assignment.

Move the file to the edge machine over a channel you trust and delete the
center's copy. On the edge the credential goes in the workspace's
`fleet-edge.json` (`credential`), or on the command line as
`ha daemon fleet edge sync --credential`; prefer the file, which keeps it out
of the process list and shell history.

To change a node's owner, read its `version` from `node-list` and repeat
`node-register` with `--person-id <new-person> --expected-version <version>`.
No credential is minted and `--credential-file` is not needed.

If registration created the Keycloak client but failed before returning its
credential, do not reuse that incomplete registration. Read its version with
`node-list`, remove it with `node-unregister --node-id <node-id>
--expected-version <version>`, then register it again with a new credential
file. Automatic cleanup of this partial registration is tracked separately.

### Human confirmation

A Fleet node authenticates as a machine, even when its owner is a person.
`ha task review-consent` from that connection is refused with
`human_confirmation_required`. Sign in as a person at the center and record
the review consent there. Interactive sign-in from an edge is not available
in this version; node credentials cannot stand in for that confirmation.

To remove a node:

```bash
ha bootstrap --operation node-unregister --node-id <node-id> --expected-version <version>
```

A stale version answers `version_conflict`. After removal the credential is
rejected on new connections. A connection that was already open may still get
answers to some frames (tracked as `task_957ec2cdea3f65a73487641bdb`), and
leases the node holds are reclaimed by their existing timeout, not revoked.

### When a first sync is refused

| Code | Meaning |
| --- | --- |
| `authentication_failed` | The node is not registered, or the credential is wrong. The two are deliberately indistinguishable. |
| `authorization_denied` | The node is registered, but its owner holds no grant for `daemon-fleet-edge-sync` on the repository. |

If outbound GitHub access is unreliable, preseed `~/harness-center/app` with a
clean Git checkout containing `HARNESS_CENTER_APP_REF`. `up` only fetches when
that pinned ref is absent, so an audited Git bundle or rsync transfer works
without changing the deployment contract.
