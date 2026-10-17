# Install and join an edge

On a clean macOS or Linux machine, run the source installer:

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

The installer keeps the checkout under `~/.local/share/harness-anything`, runs `npm ci`, builds the daemon and CLI,
and creates the `ha` command with `npm link`. On Linux it applies Electron's required `chrome-sandbox` mode. The
repository is source distributed; signed installers and registry packages are not claimed.

Then consume the center invitation:

```bash
ha edge join '<invite-link>' --observed-spki-sha256 '<SPKI pin>'
```

The command uses the existing typed `daemon.rbac.manage` edge-join consume action. The center daemon serializes
consumption, checks the invitation's SPKI pin and signed-in person, and rejects expired or already-consumed links.
After admission, the existing remote-edge registration and resident replica path owns `fleet-edge.json` and performs
the first sync. Multiple edges have independent node credentials; the center's single writer owns invitation
consumption and lease/replication coordination.

On Wayland, use `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`. To inspect the resulting repository and dispatch an Agent,
run `ha gui --root <edge-repository>` or the normal `ha runtime run` command from that repository.
