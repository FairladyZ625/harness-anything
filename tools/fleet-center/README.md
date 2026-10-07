# Fleet center user-space deployment

[English](./README.md) | **简体中文**

`centerctl.sh` is the W5-R production-cutover rehearsal deployment for
`tencent-lighthouse-prod`. It installs the pinned Node 24 tarball under the
login user's home, clones/builds Harness Anything, restores a ledger backup
into `~/harness-center/repo` and attaches it as `remote-center`, starts the
managed authorization service, generates private TLS material, and starts the daemon-owned TLS center. It never uses sudo,
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
the authorization service, TLS material and Fleet listener.

Subsequent lifecycle operations do not need the backup directory:

```bash
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh status'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh down'
ssh tencent-lighthouse-prod '~/harness-center/bin/centerctl.sh up'
```

`down` only stops this deployment's isolated daemon. It intentionally retains
the repository, TLS material and replica state for audit/recovery.
After a host reboot, log in and run `up` to start the daemon. Its Fleet listener
restores the last successfully saved configuration automatically. `down` retains
that enabled intent.

Human identity and repository permissions come from Keycloak; a restored
repository's `people.yaml` does not grant access. The deployment does not admit local repository writes to the remote
center: writes arrive from Fleet edges with node credentials, and a person
signs in through the desktop app connected to this daemon.

## Nodes and task leases

`up` starts the listener for `repoId`; it creates no static execution roster.
Keycloak's node registry provides each node's machine credential and current owner.
`centerctl.sh` creates no credential and registers no node. An authorized person
assigns tasks to a person, node or native Keycloak team. Execution nodes then
compete for the single canonical task lease; the first eligible claimant wins.

Before it starts the Fleet listener, `up` runs `ha bootstrap`, which installs
and starts the managed Keycloak and PostgreSQL under this deployment's user
root. That step needs no sign-in. It downloads its runtimes from
`repo1.maven.org`, `api.adoptium.net`, and `github.com`, and its receipt is
kept at `~/harness-center/rbac-bootstrap.json`.

Everything after that needs a person and is not run by the script:

1. Create the first administrator through the desktop app or
   `ha bootstrap --operation bootstrap-admin` with the required identity fields
   and `--password-file` (see `ha bootstrap --help`). Sign in through the app or
   `ha bootstrap --operation login`, which uses device login without a local browser.
2. Give the node's owner an account and grant that person
   `daemon-fleet-edge-sync` on the repository.
3. Register the node, signed in as an administrator holding `access-admin`.

After Keycloak is running, the listener can be started before or after an
administrator signs in. Starting or restarting it while signed in is allowed
when that person has the repository's `daemon-fleet-center-start` permission.

`ha daemon fleet center start --port <port> --key <key.pem> --cert <cert.pem>
--repo <repo-id> --quota-bytes <bytes>` explicitly replaces this daemon's existing
listener, including on the same port. It interrupts existing edge connections.
Authorization, parameters and TLS material are checked before the old listener
closes; rejected input leaves it running. The success receipt reports `replaced`
and `serviceStatus: listening`. Startup or save failure reports that the center
is not listening; a save failure closes the new listener. The last successfully
saved intent remains for the next daemon start. There is no automatic rollback
and no separate center-stop command.

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
receipt names the file and never carries the credential. The registration is
refused with `credential_file_required` without `--credential-file`, and with
`credential_file_unavailable` when the file already exists; in both cases
nothing is registered. Use one directory per node and never share a credential
between nodes. `<node-id>` identifies the authenticated execution node.

Move the file to the edge machine over a channel you trust and delete the
center's copy. On the edge the credential goes in the workspace's
`fleet-edge.json` (`credential`), or on the command line as
`ha daemon fleet edge sync --credential`; prefer the file, which keeps it out
of the process list and shell history.

To change a node's owner, read its `version` from `node-list` and repeat
`node-register` with `--person-id <new-person> --expected-version <version>`.
No credential is minted and `--credential-file` is not needed.

The credential file is written before the Keycloak client is created, so a registration
either takes effect with the credential in its file or fails without leaving a client
behind. A registration that reports failure with the file already in place is settled by
what `node-list` shows: when the node is registered, the file holds its working credential
and there is nothing to redo; when it is not, remove the file and register again.

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

A stale version answers `version_conflict`. Once removal settles, the
credential is rejected on new connections and the node's live TLS sessions at
the center are cut before the operation returns, their buffered frames neither
processed nor answered; a removal settled later by `receipt-reconcile` cuts
them too. Leases the node holds are reclaimed by their existing timeout, not
revoked.

### When a first sync is refused

| Code                    | Meaning                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `authentication_failed` | The node is not registered, or the credential is wrong. The two are deliberately indistinguishable.  |
| `authorization_denied`  | The node is registered, but its owner holds no grant for `daemon-fleet-edge-sync` on the repository. |

If outbound GitHub access is unreliable, preseed `~/harness-center/app` with a
clean Git checkout containing `HARNESS_CENTER_APP_REF`. `up` only fetches when
that pinned ref is absent, so an audited Git bundle or rsync transfer works
without changing the deployment contract.
