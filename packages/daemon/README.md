# Harness Anything daemon

The resident service and runtime worker host for Harness Anything. Requires Node 24 or newer and uses the same release version as the CLI.

```sh
harness-anything-daemon serve --user-root /path/to/daemon-state --daemon-id default
harness-anything-daemon --service --user-root /path/to/daemon-state --daemon-id default
```

Both modes run the resident process in the foreground; `ha daemon start --service` handles detached startup and readiness. Clients must complete an exact protocol major/minor `protocol.hello` before sending requests. A second process for the same user root and daemon ID defers to the singleton owner. SIGTERM, SIGINT, and `daemon.stop` drain the resident service.

`--runtime-worker-host` is the internal stdin-manifest entry used by daemon dispatch. It persists provider output and process exit records and runs independently of the resident daemon so a restarted daemon can adopt its pid. It is not an RPC server.

Build and verify the package from a source checkout:

```sh
npm run build -w @harness-anything/daemon
node tools/dispatch-isolated-test.mjs --target ubuntu --file packages/daemon/test/daemon-package.integration.test.mjs
```

The smoke packs the workspace, installs it into a temporary consumer, exercises both resident modes with hello and singleton checks, and verifies the worker's persisted output. No npm publication is performed.

## Devices and sign-in

A registered device belongs permanently to one person. Its Keycloak client identifies the device;
repository actions require that person's current device session. A device session cannot record a
human review consent. Confirm reviews through the center's interactive interface.

Use **Identity & access → My devices** to rename, pause, resume or remove your devices, or sign out
all of them. Renaming keeps the device ID. Removal keeps a disabled tombstone; register a new ID
for a replacement. Pausing revokes the device's native Keycloak consent. Resuming permits a new
sign-in and never restores the old token. A revocation failure remains pending and is not reported
as completed; refresh the list and explicitly repeat the revoke action to finish it.

The center CLI uses the same service:

```sh
ha bootstrap --operation device-list
ha bootstrap --operation device-rename --node-id <id> --display-name <name> --expected-version <version> --operation-id <unique-id>
ha bootstrap --operation device-pause --node-id <id> --expected-version <version> --operation-id <unique-id>
ha bootstrap --operation device-resume --node-id <id> --expected-version <version> --operation-id <unique-id>
ha bootstrap --operation device-remove --node-id <id> --expected-version <version> --operation-id <unique-id>
ha bootstrap --operation device-logout-all --expected-version '<list-version>' --operation-id <unique-id>
```

Device login requests `offline_access`: refresh tokens rotate, the absolute offline maximum is
unlimited, and the idle window is **90 days**. A device unused beyond that window needs approval
again. Ordinary browser SSO lifetime remains a separate setting. A new device sign-in first
revokes that device's previous consent. Other devices keep their own sessions.

**Changing a password or signing out in the Keycloak console does not reliably disconnect these offline
devices. Remove a device or sign out all devices in Harness to revoke their access.** This is the
verified Keycloak native boundary; no event plugin or polling service is installed. Revocation
blocks the next center request, including requests on an existing connection. Already downloaded
files and disconnected local processes cannot be remotely erased or guaranteed stopped.

设备永久属于登记的主人。请在「账号与访问控制 → 我的设备」改名、暂停、恢复、移除或登出所有设备。
改名不改 ID；移除保留禁用记录且不能复活；暂停会显式撤销原生授权，恢复必须重新批准登录。
撤销失败保持「待处理」，刷新后明确再次执行撤销即可继续，不能把失败当作完成。
长期登录使用独立、轮换的 offline 凭据，离线超过 90 天需要重新批准。
**在 Keycloak 控制台改密或退出不保证让设备下线，请在 Harness 中移除设备或登出所有设备。**
已下载数据不能远程召回，断网进程是否停止须另行确认；设备令牌也不能代替真人确认评审。
