# Install and join an edge

Joining a center takes two steps: install the desktop app, then finish joining with the invitation link. Everything
runs in the GUI; the source checkout and the `ha edge join` command remain as a fallback at the end of this page.

## 1. Install the desktop app

Download a package from [GitHub Releases](https://github.com/FairladyZ625/harness-anything/releases):

- macOS (Apple silicon): a signed and notarized `dmg` or `zip`. Open the `dmg` and drag **Harness Anything** into
  Applications.
- Windows: x64 NSIS installer; SmartScreen may appear on first run.
- Linux: x64 AppImage or deb.

The app ships its own runtime, so Node.js and Git are not required. See [Install](01-install.md) for details.

On macOS, launching the app before it has been moved into Applications shows a dialog that offers to move it there;
accepting the prompt moves it automatically, and declining still lets you continue for that session.

## 2. Admin: issue a one-time invitation

In the center GUI, open **Settings → Repos & connections** and click **Invite a member** on the card at the top of the
page; that opens the invitation form directly:

1. Under **Member**, pick an existing member or choose **New member…** and fill in the username, email, and display
   name; optionally set an **Edge node label (optional)**.
2. Tick the **Repositories** and **Permission groups** to grant.
3. Click **Issue invitation**. The one-time link is shown once: click **Copy link** and send it to that person over a
   separate channel (chat or email); after **Done** the link cannot be retrieved again.

If this machine cannot act as the center yet (the login service certificate is not configured), the entry does not hide
the invitation; it names the missing step first: click **Configure the login service**, finish the certificate setup,
then come back to **Invite a member** and issue the invitation.

The invitation expires after 72 hours and can be consumed once. The **Invitation audit** list shows each invitation as
Pending / Consumed / Expired / Revoked, and a pending invitation can be withdrawn with **Revoke**. Do not post the link
publicly.

### Configure addresses reachable by edge nodes

In **Settings → Repos & connections → Center node**, configure the center service address and sign-in service address
separately. Enter a complete HTTPS origin for the center (for example, `https://center.example.com:7545`). The sign-in
address comes from the hostname and port in the login service certificate settings. They may use different hosts and
ports. These client-facing addresses are separate from the daemon and Keycloak bind addresses. The center TLS
certificate SAN must cover the center host; the login certificate must cover the sign-in hostname. The sign-in
hostname is also the Keycloak issuer, so changing it requires existing sessions to authenticate again.

Both addresses must resolve and be reachable from the edge network, with working DNS, routing, firewall rules, and NAT
port forwarding. The center attempts a reachability check when its address is saved, but hairpin NAT can cause a false
warning. Before sign-in, the join wizard checks the center and sign-in services separately and identifies which one
failed. The product does not relay traffic: a public address without a working port mapping remains unreachable.

If the center has only private network addresses, create SSH local forwards on the edge machine. The invitation
hostnames must point to the local forwarding addresses on that machine, and the sign-in certificate must still be
trusted:

```bash
ssh -N \
  -L <center-host-from-invite>:<center-port>:<center-private-host>:<center-port> \
  -L <login-host-from-invite>:<login-port>:<login-private-host>:<login-port> \
  <jump-host-login>
```

If an invitation hostname is not already a local address on the edge machine, map it to the SSH listener with a local
loopback alias or local DNS/hosts entry first. Forwarded ports must match the invitation URLs.

## 3. Join from the invitation link

Either way works:

- Click the `harness-edge://join/…` link in the invitation message; the app opens with the link pre-filled, or
- Open the app, click **Join a center** on the home page (the empty state before any project exists) or in the top-left
  project switcher, and paste the invitation link into the **Invitation link** field.

Click **Start joining**. The link stays on this machine and is never uploaded or logged; the invitation link already
carries the trust information, so no manual configuration is needed.

## 4. Device sign-in in the browser

The wizard shows the **Sign-in address** and the **Code**:

1. Click **Open in browser** (or open the address manually), enter the code in the browser, and approve the sign-in;
   **Copy the code** copies it to the clipboard.
2. While waiting, the app shows “Waiting for approval…”; it continues on its own once approved. **Cancel sign-in**
   returns to the previous step.

If the sign-in service is unreachable, the app says so and retries automatically.

## 5. First sync

The wizard walks each invited repository through Preparing workspace → Registering repository → First sync → Synced.
When it finishes you see “Joined; switched to the first joined repository.”; if some repositories fail you see
“Some repositories did not sync; retry later or contact your inviter.”, and the failed rows list the reason.

## 6. When something goes wrong

The wizard pairs every failure with a suggested next step. Common cases:

| What the app shows | What to do |
| --- | --- |
| The invitation link is invalid or damaged. | Ask your inviter for a fresh link and try again. |
| The invitation has expired. | Ask your inviter to issue a new invitation. |
| The invitation was already used; a one-time link cannot join twice. | Ask your inviter to issue a new invitation. |
| The invitation was revoked. | Ask your inviter to issue a new invitation. |
| The center's certificate fingerprint does not match the invitation. | Confirm the link came from a trusted administrator; if the certificate really rotated, ask for a new invitation. |
| The signed-in account does not match the invited person. | Sign in as the invited person, or ask for an invitation for the account you use. |
| The permissions captured with the invitation have changed. | Ask your inviter to reissue against the current permissions. |
| This app version differs from the center; the handshake was refused. | Upgrade the app to the same version as the center and retry. |
| The device sign-in timed out before approval. | Start over and complete the browser sign-in in time. |
| The sign-in service is unreachable. | Check the network and retry; contact the center administrator if it persists. |
| The sign-in service refused this device login. | Start over; contact the center administrator if it persists. |
| Joining failed; the center or sign-in service returned an error. | The app also shows the center's original explanation; follow it or contact your inviter. |

## Fallback: source install and the command line

On machines without an app package, install from source and join from the command line. On a clean macOS or Linux
machine, check for Git, Node.js 24+, and curl:

```bash
git --version
node --version  # must be v24 or newer
curl --version
```

```bash
curl -fsSL https://raw.githubusercontent.com/FairladyZ625/harness-anything/main/scripts/install-source.sh | bash
```

The installer keeps the checkout under `~/.local/share/harness-anything`, runs `npm ci`, builds the daemon, CLI and
Electron GUI bundles, and creates the `ha` command with `npm link`. On Linux it sets Electron's `chrome-sandbox`
owner and setuid mode (using `sudo` when needed).

The invited person runs:

```bash
ha edge join '<invite-link>'
```

The command completes the device sign-in, consumes the invitation, and finishes the first sync for each selected
repository. It writes the machine credential only to the local edge configuration; the join receipt and status view
do not return that credential. A changed repository or permission-group snapshot is rejected, so the inviter must
issue a fresh invitation after changing the selected access.

On Wayland, use `ELECTRON_OZONE_PLATFORM_HINT=auto ha gui`. To inspect the resulting repository and dispatch an Agent,
run `ha gui --root <edge-repository>` or the normal `ha runtime run` command from that repository.
