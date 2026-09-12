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
