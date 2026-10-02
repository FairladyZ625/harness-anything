# Provider API keys

API-key providers support replacing a key without recreating the instance. Its
identity, models, default model, endpoint and other settings remain unchanged
unless included in the same update. Subscription providers keep their existing
authentication mode.

In **Providers**, select the repository/server, edit the provider and enable
**Replace API key**. Enter the new key and save. The field never contains the old
key. Leaving replacement disabled keeps the current key. A rejected save keeps
the other form fields and clears the password field; enter the key again to retry.
Keep the selected server unchanged while saving.

## CLI input

Run on the server that owns the instance, or use the already configured protected
local endpoint for that server. Read a protected file or redirected stdin:

```bash
ha runtime instance update my-provider --api-key-file /private/path/provider-key --json
ha runtime instance update my-provider --api-key-stdin < /private/path/provider-key
```

Use file permissions `0600`, keep the file outside repositories, and remove it
when no longer needed. The filename is visible in process arguments; the key is
not. To avoid a file, Bash can read without echoing or putting the key in history:

```bash
IFS= read -r -s -p 'New provider API key: ' provider_key
printf '\n'
printf '%s' "$provider_key" | ha runtime instance update my-provider --api-key-stdin
unset provider_key
```

The same input options work with `ha runtime instance create ... --auth
api-key`. `--api-key-stdin` and `--api-key-file` are mutually exclusive. There is
no key argument. Omit both options when changing only metadata. Blank, multiline
and oversized keys are rejected.

## Storage, targets and receipts

GUI and CLI use the same lifecycle service in the selected target daemon. The
target stores the new key in its native vault, confirms it can read it, then
atomically publishes a new reference. Same-target instance commands and launch
credential resolution share a FIFO. A later successful replacement wins. Vault
or configuration rejection preserves the previous reference; unused new items
are removed. Retired items are removed only when no other instance or GitHub
credential setting references them.

Success reports `credentialChanged: true`. `credentialCleanup: retained` means
the new key is configured but the vault refused cleanup of an unused old item;
the receipt explains the required inspection. Success confirms configuration,
not paid provider authentication. Use the provider's validation action separately.
Public instance metadata, logs and receipts do not contain the key. Runtime-native
private configuration may contain required secret material, such as Codex's
`config.toml`; it remains outside the repository with restricted permissions.

The next launch resolves the new key and refreshes its native configuration.
Replacement does not restart existing processes or change their launch
environment. Codex shares native configuration between same-instance processes;
a process that rereads that file may observe its later atomic refresh. Harness
does not promise an immutable per-process configuration snapshot.

Remote GUI requests preserve the selected repository/connection. New keys are
accepted through owner-bound local sockets or loopback endpoints for the existing
user-managed protected tunnel. Bare remote TCP hosts are rejected before sending
the secret. Set up the existing SSH socket tunnel first:

```bash
ssh -L 9911:/path/to/server-daemon.sock server-host -N
ha daemon repo register --repo-id server-repo --mode remote-proxy --endpoint tcp://127.0.0.1:9911
```

Select `server-repo` in the GUI. Loopback TCP itself is not encrypted; Harness
does not verify the external tunnel. The tunnel and local access remain the
operator's responsibility. See [server connections](operations-server-daemon.md).

## Linux without a desktop

Linux uses Secret Service through `secret-tool`. A desktop is not required, but
the daemon needs an unlocked persistent keyring on the same user's D-Bus session.
On Debian/Ubuntu, install the `dbus`, `libsecret-tools` and `gnome-keyring` packages.
Use a dedicated daemon user/root rather than an unrelated user's desktop keyring.

For an interactive headless session, start a user bus and unlock the login
keyring through stdin. These are Bash commands:

```bash
dbus-run-session -- bash
# Inside that shell:
IFS= read -r -s -p 'Login keyring password: ' keyring_password
printf '\n'
printf '%s' "$keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset keyring_password
export HARNESS_DAEMON_USER_ROOT="$HOME/.harness-provider-server"
export HARNESS_DAEMON_ID=provider-server
ha daemon start --service
# Create/update providers and run workloads here; keep this shell/session alive.
# Before leaving the session:
ha daemon stop --daemon-id provider-server
exit
```

`--unlock` reads the password from stdin and unlocks (or creates) the login
keyring. This example uses a dedicated root without an installed supervisor
unit, so the resident daemon inherits this shell's bus. Exiting `dbus-run-session`
ends that bus. For a permanently supervised server, provision the user bus and
keyring in the supervisor's session and supply the same `DBUS_SESSION_BUS_ADDRESS`
to the daemon. Installing a user service from a temporary shell does not arrange
that environment or unlock it after reboot.

Missing `secret-tool`, a missing bus or a locked/unavailable keyring produces
`runtime_credential_unavailable` with this setup guidance. No plaintext vault
fallback is provided. Native headless Linux execution needs an actual Linux
Secret Service environment; command-construction tests on another OS do not
constitute that verification.

Upstream references: [GNOME Keyring startup](https://wiki.gnome.org/Projects%282f%29GnomeKeyring%282f%29RunningDaemon.html),
[daemon options and unlock implementation](https://github.com/GNOME/gnome-keyring/blob/main/daemon/gkd-main.c),
[secret-tool stdin and clear implementation](https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c).
