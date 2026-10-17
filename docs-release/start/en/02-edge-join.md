# Install and join an edge

On a clean macOS or Linux machine, run the source installer:

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

The installer keeps the checkout under `~/.local/share/harness-anything`, runs `npm ci`, builds the daemon, CLI and
Electron GUI bundles, and creates the `ha` command with `npm link`. On Linux it sets Electron's `chrome-sandbox`
owner and setuid mode (using `sudo` when needed). The repository is source distributed; signed installers and registry
packages are not claimed.

Then consume the center invitation:

```bash
ha edge join '<invite-link>' --observed-spki-sha256 '<SPKI pin>'
```

The typed command currently consumes through the local daemon access-admin writer. The center-side admission,
credential minting, remote-edge registration and first-sync orchestration remain the required follow-up boundary for
a clean machine; they are listed in `artifacts/breakpoints.md` and are not claimed as verified by this page.

On Wayland, use `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`. To inspect the resulting repository and dispatch an Agent,
run `ha gui --root <edge-repository>` or the normal `ha runtime run` command from that repository.
