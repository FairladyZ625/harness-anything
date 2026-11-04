// harness-test-tier: fast
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/client";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";

/**
 * issue #4267: 同一个 Electron 主进程在旧项目根被删掉后打开/切到新项目,台账桥、在跑的任务、
 * 工作简报必须用**请求里选中的 repo** 解析根目录,而不是进程启动时捕获的 HARNESS_GUI_ROOT。
 *
 * 修前:bridge 闭包持有启动根,任何 repo 作用域请求都先 bind 旧根 → invalid_root。
 * 修后:每条请求按 repoId 从 daemon registry 取该仓的 canonicalRoot;旧根不再参与。
 */

const METHODS = ["repo.tasks.list", "repo.tasks.wip", "repo.works.briefs.read"] as const;
type Seen = { readonly method: string; readonly repoId: unknown };

function writeProject(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-config/v1\n");
}

function taskList() {
  return {
    ok: true,
    status: "ready",
    rows: [],
    invalidRows: [],
    watermark: 0,
    sourceRevision: 0,
    warnings: [],
  };
}

function taskWip() {
  return { ok: true, limit: 1, limitLabel: "1", counted: [], roots: [], threshold: 1 };
}

function workBriefs() {
  return {
    schema: "daemon.work-briefs/v1",
    ok: true,
    status: "ready",
    briefs: [],
    watermark: 0,
    sourceRevision: 0,
    warnings: [],
  };
}

function responseFor(method: string): unknown {
  if (method === "repo.tasks.list") return taskList();
  if (method === "repo.tasks.wip") return taskWip();
  if (method === "repo.works.briefs.read") return workBriefs();
  throw new Error(`unexpected fixture method ${method}`);
}

describe("repo-scoped GUI reads after the startup root disappears", () => {
  let parent: string, userRoot: string, socketPath: string, server: net.Server | undefined;
  const seen: Seen[] = [];
  const previous = {
    root: process.env.HARNESS_DAEMON_USER_ROOT,
    id: process.env.HARNESS_DAEMON_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
    guiRoot: process.env.HARNESS_GUI_ROOT,
  };
  const daemonId = "stale-root";

  async function startDaemon(): Promise<void> {
    server = net.createServer((socket) => {
      const lines = createInterface({ input: socket });
      lines.on("line", (line) => {
        const request = JSON.parse(line) as {
          readonly id: number;
          readonly method: string;
          readonly params?: { readonly repo?: { readonly repoId?: unknown } };
        };
        if (request.method === "protocol.hello") {
          socket.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { ...fixtureDaemonHello(), methods: ["protocol.hello", ...METHODS] },
            })}\n`,
          );
          return;
        }
        seen.push({ method: request.method, repoId: request.params?.repo?.repoId });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: responseFor(request.method) })}\n`);
      });
    });
    mkdirSync(path.dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
  }

  beforeEach(async () => {
    parent = mkdtempSync(path.join(tmpdir(), "ha-gui-stale-root-"));
    const oldRoot = path.join(parent, "old-project"),
      newRoot = path.join(parent, "new-project"),
      thirdRoot = path.join(parent, "third-project");
    userRoot = path.join(parent, "user");
    socketPath = localUserDaemonEndpoint(userRoot, daemonId);
    for (const root of [oldRoot, newRoot, thirdRoot]) writeProject(root);
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: oldRoot,
      repoId: "old-repo",
      displayName: "old-project",
      authoredBranch: "main",
    });
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: newRoot,
      repoId: "new-repo",
      displayName: "new-project",
      authoredBranch: "main",
    });
    writeDaemonRegistryRepo({
      userRoot,
      canonicalRoot: thirdRoot,
      repoId: "third-repo",
      displayName: "third-project",
      authoredBranch: "main",
    });
    // The reported sequence: the previous project directory is gone while Electron stays alive.
    rmSync(oldRoot, { recursive: true, force: true });
    process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
    process.env.HARNESS_DAEMON_ID = daemonId;
    delete process.env.HARNESS_DAEMON_ENDPOINT;
    // The process still carries the deleted startup root; no request may read it.
    process.env.HARNESS_GUI_ROOT = oldRoot;
    await startDaemon();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
    server = undefined;
    if (previous.root === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previous.root;
    if (previous.id === undefined) delete process.env.HARNESS_DAEMON_ID;
    else process.env.HARNESS_DAEMON_ID = previous.id;
    if (previous.endpoint === undefined) delete process.env.HARNESS_DAEMON_ENDPOINT;
    else process.env.HARNESS_DAEMON_ENDPOINT = previous.endpoint;
    if (previous.guiRoot === undefined) delete process.env.HARNESS_GUI_ROOT;
    else process.env.HARNESS_GUI_ROOT = previous.guiRoot;
    rmSync(parent, { recursive: true, force: true });
  });

  it("reads the ledger bridge, running tasks and work brief from the newly opened project", async () => {
    const bridge = createLocalGuiServiceBridge();
    const tasks = (await bridge.invoke("getTasks", { repoId: "new-repo" })) as { readonly ok?: boolean };
    const wip = (await bridge.invoke("getTaskWip", { repoId: "new-repo" })) as { readonly ok?: boolean };
    const briefs = (await bridge.invoke("getWorkBriefs", { repoId: "new-repo" })) as { readonly ok?: boolean };
    expect(tasks.ok, JSON.stringify(tasks)).toBe(true);
    expect(wip.ok).toBe(true);
    expect(briefs.ok).toBe(true);
    expect(seen).toEqual([
      { method: "repo.tasks.list", repoId: "new-repo" },
      { method: "repo.tasks.wip", repoId: "new-repo" },
      { method: "repo.works.briefs.read", repoId: "new-repo" },
    ]);
    expect(JSON.stringify([tasks, wip, briefs])).not.toContain("invalid_root");
  });

  it("switches every repo-scoped read to the project selected in the same window", async () => {
    const bridge = createLocalGuiServiceBridge();
    await bridge.invoke("getTasks", { repoId: "new-repo" });
    seen.length = 0;
    await bridge.invoke("getTasks", { repoId: "third-repo" });
    await bridge.invoke("getTaskWip", { repoId: "third-repo" });
    await bridge.invoke("getWorkBriefs", { repoId: "third-repo" });
    expect(seen).toEqual([
      { method: "repo.tasks.list", repoId: "third-repo" },
      { method: "repo.tasks.wip", repoId: "third-repo" },
      { method: "repo.works.briefs.read", repoId: "third-repo" },
    ]);
  });
});
