// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SshStdioTransport } from "../../daemon-client/src/ssh-stdio-transport.ts";
import {
  FakeTransport,
  hello,
  receipt,
  type RequestFrame
} from "../../daemon-client/test/fake-transport.ts";
import {
  createGuiProjectionNotifications,
  createGuiServiceBridge,
  createLocalGuiServiceBridge
} from "../src/index.ts";
import {
  daemonPidFromStatus,
  daemonStatusData,
  readDaemonStatus,
  stopDaemonProcess,
  waitForDaemonIdle,
  withGuiDaemonEnv,
  writeTaskIndex
} from "./helpers/daemon-generation-lifecycle.ts";

test("GUI remote selection reads tasks and documents from a second repo over daemon stdio", async () => {
  const nearRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-near-"));
  const remoteRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-remote-"));
  let remoteDaemonPid: number | undefined;
  try {
    writeTaskIndex(nearRoot, "task-near", "Near-only task", "planned");
    writeTaskIndex(remoteRoot, "task-remote", "Remote-only task", "planned");

    const local = await withGuiDaemonEnv(nearRoot, async () => {
      const bridge = createGuiServiceBridge(nearRoot, undefined, {
        env: { ...process.env, HARNESS_DAEMON_MODE: "local" }
      });
      try {
        return await bridge.invoke("getTasks", null) as { readonly ok: boolean; readonly tasks?: ReadonlyArray<{ readonly taskId?: string }> };
      } finally {
        await bridge.dispose?.();
      }
    });
    assert.deepEqual(local.tasks?.map((task) => task.taskId), ["task-near"]);

    await withGuiDaemonEnv(remoteRoot, async () => {
      const localRemoteBridge = createLocalGuiServiceBridge(remoteRoot);
      const warm = await localRemoteBridge.invoke("getTasks", null) as { readonly ok: boolean };
      assert.equal(warm.ok, true);
      const status = daemonStatusData(await readDaemonStatus(remoteRoot));
      const endpoint = status.endpoint;
      assert.equal(typeof endpoint, "string");
      remoteDaemonPid = daemonPidFromStatus(status);

      const sshCalls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
      const remoteEnv = {
        ...process.env,
        HARNESS_DAEMON_MODE: "remote",
        HARNESS_DAEMON_SSH_HOST: "fixture-remote",
        HARNESS_DAEMON_REMOTE_HA: "/opt/ha",
        HARNESS_DAEMON_REMOTE_ROOT: remoteRoot,
        HARNESS_DAEMON_REPO_ID: "canonical",
        HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "5000"
      };
      const createEquivalentStdioTransport = (transport: { readonly host: string; readonly remoteHaPath: string }) => new SshStdioTransport({
        host: transport.host,
        remoteHaPath: transport.remoteHaPath,
        spawnProcess: (command, args, options) => {
          sshCalls.push({ command, args });
          return spawn(process.execPath, [
            fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url)),
            "daemon",
            "connect",
            "--stdio",
            "--socket",
            endpoint as string
          ], { ...options, cwd: remoteRoot, env: process.env });
        }
      });
      const remote = createGuiServiceBridge(nearRoot, undefined, {
        env: remoteEnv,
        createSshTransport: createEquivalentStdioTransport
      });
      try {
        const tasks = await remote.invoke("getTasks", null) as {
          readonly ok: boolean;
          readonly tasks?: ReadonlyArray<{ readonly taskId?: string }>;
        };
        const document = await remote.invoke("getTaskDocument", {
          taskId: "task-remote",
          path: "INDEX.md"
        }) as { readonly ok: boolean; readonly body?: string };

        assert.equal(tasks.ok, true, JSON.stringify(tasks));
        assert.deepEqual(tasks.tasks?.map((task) => task.taskId), ["task-remote"]);
        assert.equal(tasks.tasks?.some((task) => task.taskId === "task-near"), false);
        assert.equal(document.ok, true, JSON.stringify(document));
        assert.match(document.body ?? "", /Remote-only task/u);
        assert.deepEqual(sshCalls[0], {
          command: "ssh",
          args: ["fixture-remote", "/opt/ha", "daemon", "connect", "--stdio"]
        });
        const notifications = createGuiProjectionNotifications(nearRoot, undefined, {
          env: remoteEnv,
          createSshTransport: createEquivalentStdioTransport
        });
        try {
          assert.deepEqual(await notifications.source.watch("canonical", () => undefined), { mode: "push" });
        } finally {
          await notifications.dispose();
        }
      } finally {
        await remote.dispose?.();
      }
    }, { idleMs: "5000" });
  } finally {
    await stopDaemonProcess(remoteDaemonPid);
    await waitForDaemonIdle();
    rmSync(nearRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test("GUI remote requests carry the canonical root required by the forced-command boundary", async () => {
  const nearRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-near-"));
  const requests: RequestFrame[] = [];
  const transport = new FakeTransport((request, connection) => {
    requests.push(request);
    if (hello(connection, request)) return;
    connection.respond(request.id, receipt(request.method, { ok: true, tasks: [] }));
  });
  const remoteRoot = "/srv/harness/gui-remote";
  const bridge = createGuiServiceBridge(nearRoot, undefined, {
    env: remoteDaemonEnv(remoteRoot),
    createSshTransport: () => transport
  });
  try {
    const tasks = await bridge.invoke("getTasks", null) as { readonly ok: boolean };

    assert.equal(tasks.ok, true, JSON.stringify(tasks));
    const request = requests.find((candidate) => candidate.method === "repo.tasks.list");
    assert.deepEqual(request?.params, {
      repo: { repoId: "canonical", canonicalRoot: remoteRoot }
    });
  } finally {
    await bridge.dispose?.();
    rmSync(nearRoot, { recursive: true, force: true });
  }
});

test("GUI remote mode fails closed when the persistent daemon is unavailable", async () => {
  const nearRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-near-"));
  writeTaskIndex(nearRoot, "task-near", "Near-only task", "planned");
  const bridge = createGuiServiceBridge(nearRoot, undefined, {
    env: remoteDaemonEnv("/srv/harness/gui-remote"),
    createSshTransport: () => ({
      open: async () => {
        throw new Error("No persistent daemon is listening on the remote host");
      }
    })
  });
  try {
    const tasks = await bridge.invoke("getTasks", null) as {
      readonly ok: boolean;
      readonly tasks?: ReadonlyArray<unknown>;
      readonly error?: { readonly code?: string; readonly hint?: string };
    };

    assert.equal(tasks.ok, false, JSON.stringify(tasks));
    assert.equal(tasks.error?.code, "daemon_unavailable");
    assert.match(tasks.error?.hint ?? "", /fixture-remote.*No persistent daemon/iu);
    assert.equal(tasks.tasks, undefined);
  } finally {
    await bridge.dispose?.();
    rmSync(nearRoot, { recursive: true, force: true });
  }
});

function remoteDaemonEnv(remoteRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HARNESS_DAEMON_MODE: "remote",
    HARNESS_DAEMON_SSH_HOST: "fixture-remote",
    HARNESS_DAEMON_REMOTE_HA: "/opt/ha",
    HARNESS_DAEMON_REMOTE_ROOT: remoteRoot,
    HARNESS_DAEMON_REPO_ID: "canonical",
    HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "5000"
  };
}
