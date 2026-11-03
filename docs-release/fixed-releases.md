# Fixed daemon releases

Development builds and production must use separate executable trees and daemon state roots. Keep production ledger data in its existing location; installing a release does not move or initialize data.

The release installer uses independent version directories and an atomically replaced `current` link. This follows the generation model described in [Nix profiles](https://nix.dev/manual/nix/2.28/package-management/profiles.html). Dependencies use the lockfile through [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/). No Nix installation is required. These tools target macOS and Linux.

## Install and switch

Run from an operator shell with Node 24+, npm, Git and the native build tools required by node-pty. Choose an installation root outside every development checkout. The following variables are operator-selected paths, and `CANDIDATE` is the full commit that passed release qualification:

```sh
node tools/release-installation.mjs install \
  --root "$INSTALL_ROOT" --repository "$PUBLIC_CHECKOUT" --revision "$CANDIDATE"
node tools/release-installation.mjs switch \
  --root "$INSTALL_ROOT" --revision "$CANDIDATE" \
  --user-root "$STATE_ROOT" --daemon-id "$DAEMON_ID" --workspace "$LEDGER_CHECKOUT"
```

Install creates `versions/<commit>` without starting or stopping a process. It refuses to overwrite an installed version. Dependencies and workspace links belong to that installation. After compiling, npm rebuilds the CLI/daemon bin links using its [documented bin-link step](https://docs.npmjs.com/cli/v11/commands/npm-rebuild/) without rerunning lifecycle scripts. A failed install leaves its `.install-*` directory for diagnosis and does not change the active release.

Switch stops the current release using that release's CLI, records the previous version, changes `current`, and starts the candidate using its own CLI. A refused handshake, incomplete drain, failed launch or unattached repository is an error. A failed candidate remains recorded so the recovery command can stop it using its own binary.

For the first migration from a development checkout, first stop the old daemon using the old CLI. Preserve its original entry path for recovery: there is no previous installed release yet. If a service manager owns the daemon, an operator must first change its entry to the installation's `current` daemon path. These tools do not install services or change shell configuration.

Use the CLI at `$INSTALL_ROOT/current/node_modules/.bin/ha` for daily commands. Workers receive the CLI from the daemon's own installation. CLI and daemon hello exchange requires the exact protocol and source commit. On a mismatch, use the matching installed CLI or explicitly select an isolated development/test daemon. Refused hello never sends the business request, including shutdown.

## Roll back

```sh
node tools/release-installation.mjs rollback \
  --root "$INSTALL_ROOT" --user-root "$STATE_ROOT" \
  --daemon-id "$DAEMON_ID" --workspace "$LEDGER_CHECKOUT"
node tools/release-installation.mjs status --root "$INSTALL_ROOT"
```

Rollback uses the same stop/start/readiness path. It refuses when no previous release exists. Recovery of ledger data is separate: take and test a consistent backup before upgrading. An executable rollback cannot undo an incompatible data change.

A deployment lock belongs to one installer process; the updater has its own `.main-update-lock` with the same crash-recovery rule. After a crash, inspect the PID in `.deployment-lock`, prove the process has exited, and remove that lock explicitly before retrying. Preserve failed-release logs and directories. Never rebuild an installed version in place.

## Test center updates

Create a dedicated synthetic ledger and user root using the normal product initialization and login flow. Do not copy a production ledger, token or credentials. Allocate the test center's existing approved listener before connecting edges.

The one-shot updater fetches public `origin/main`, resolves the commit, and invokes the same install/switch path:

```sh
node tools/test-center-update.mjs \
  --root "$TEST_INSTALL_ROOT" --repository "$PUBLIC_MAIN_MIRROR" \
  --workspace "$TEST_LEDGER" --user-root "$TEST_STATE" --daemon-id test-center
```

An existing host scheduler can run it periodically; the tool does not install one. It needs no webhook, GitHub write token or CI SSH credential. Overlapping updater attempts are refused. A failed update attempt (fetch, install or switch) writes `failed-update.json` and prevents further deployments until an operator inspects it, rolls back, and removes the marker. Successful updates retain synthetic data so soak testing spans accumulated state.

The private-cloud image recipe is [deploy/center.Dockerfile](../deploy/center.Dockerfile). Build an image from a qualified full commit and run it with a distinct data volume. Mounting a volume, selecting an approved network listener, configuring TLS/identity and installing a scheduler remain operator deployment actions. The image is planned for the private-cloud target; this document does not claim a deployed center or a completed soak run.

## Qualification

Before production promotion, require passing affected tests, static gates and the candidate's PR CI; then keep that exact candidate in the test center for 24 continuous hours. A new candidate resets the clock. Record the measured workload, latency percentiles, errors, resource use and recovery windows. Exercise reconnect storms, slow clients, blocked drains, interrupted deployments, ledger backup/restore and the install/switch/rollback sequence. Preserve both the fixed-release rebuild control and a development-dist build-supersession control. Production upgrades remain explicit operator actions.

The expensive real-daemon qualification campaign is opt-in: select `tools/stress/release-installation.integration.test.mjs` with `FLEET_STRESS_RELEASE_INSTALL=1` through your isolated test runner. Ordinary integration tests exercise the installer and updater against a small local Git/npm fixture; that fixture does not count as real-daemon qualification.
