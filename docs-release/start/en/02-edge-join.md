# Install and join an edge

On a clean macOS or Linux machine, run the source installer:

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

The installer keeps the checkout under `~/.local/share/harness-anything`, runs `npm ci`, builds the daemon, CLI and
Electron GUI bundles, and creates the `ha` command with `npm link`. On Linux it sets Electron's `chrome-sandbox`
owner and setuid mode (using `sudo` when needed). The repository is source distributed; signed installers and registry
packages are not claimed.

In the center GUI, open **Settings → Repositories and Connections → Center** and create an invitation for the new
member. Select one or more repositories and the permission groups to include. Send the resulting link to that person
through a separate channel. The invitation expires after 72 hours, can be consumed once, and can be revoked while it
is pending. Do not post the link publicly.

The invited person runs:

```bash
ha edge join '<invite-link>'
```

The command signs in to the center's device-login service, checks the center's pinned TLS public key before sending
the invitation token or login access token, consumes the invitation, and completes the first sync for each selected
repository. It writes the machine credential only to the local edge configuration; the join receipt and status view
do not return that credential. A changed repository or permission-group snapshot is rejected, so the inviter must
issue a fresh invitation after changing the selected access.

On Wayland, use `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`. To inspect the resulting repository and dispatch an Agent,
run `ha gui --root <edge-repository>` or the normal `ha runtime run` command from that repository.
