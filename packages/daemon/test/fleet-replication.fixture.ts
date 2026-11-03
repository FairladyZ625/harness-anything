// Fleet 主从复制 C 分片的进程级 fixture:1 中心 + 3 边缘。
//
// 中心沿用既有组合根(openDaemonHost + listenFleetTls + fleetNodeOwners + 真实 openssl 证书);
// 每个边缘是一个真实 OS 子进程(fixtures/fleet-replication-edge-child.mjs),PATH 不含 Git,
// 持有独立 user-root/view-root/mirror-root,经真实 TLS 连接中心。写命令由本 fixture 直接按
// 不变的写命令合同(fleet.task.command/v1 等,contract.ts)发送;复制流按 A 分片落地的
// protocol.ts(replica.* 帧族)驱动。
//
// 待对齐(dec_9284BD6119D453EEECEED62450, C 分片): listenFleetTls 的
// replicationRetentionWindowCommits 旋钮仍为拟名(A 的 replication-slot 已有 retention,
// 会话接线落地时核对暴露面);中心 listener 在已认证会话上服务复制帧的接线是 A/B 剩余工作,
// 落地前本 fixture 的进程级集成测试按预期红在该接线缺失。
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { connect, createServer, type TLSSocket } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { makeTaskProjectionReader, sqliteLedgerPath } from "@harness-anything/storage";
import { openDaemonHost } from "../src/daemon-host.ts";
import { createIdentitySession } from "../src/authorization-provider.ts";
import { listenFleetTls, type FleetTlsCenter } from "../src/fleet/center.ts";
import { parseFleetFrame, serializeFleetFrame } from "../src/fleet/command-protocol.ts";
import { parseReplicationFrame, serializeReplicationFrame, type ReplicationFrame } from "../src/fleet/protocol.ts";
import { fleetHostWriterOptions, fleetLedgerRevision, fleetNodeOwners } from "./fleet-store.fixture.ts";
import { rawPeer } from "./fleet-tls-session.fixture.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

export const replicationNodes = ["edge-one", "edge-two", "edge-three"] as const;
export type ReplicationNodeId = (typeof replicationNodes)[number];
export const replicationRepoId = "replica-repo";
const replicaQuota = 64 * 1024 * 1024;

/** One JSON-line event emitted by the edge child process on stdout. */
export type EdgeChildEvent = {
  readonly event: string;
  readonly [field: string]: unknown;
};

/** A running edge replica: one OS process with its own roots and event history. */
export type EdgeProcess = {
  readonly nodeId: string;
  readonly root: string;
  readonly userRoot: string;
  readonly mirrorRoot: string;
  readonly viewRoot: string;
  readonly events: readonly EdgeChildEvent[];
  waitForEvent(kind: string, timeoutMs?: number): Promise<EdgeChildEvent>;
  /** Waits until some emitted event satisfies the predicate (idempotent state wait). */
  waitForWhere(predicate: (event: EdgeChildEvent) => boolean, label: string, timeoutMs?: number): Promise<void>;
  lastEvent(kind: string): EdgeChildEvent | undefined;
  control(line: Record<string, unknown>): void;
  kill(): void;
  exited: Promise<{ code: number | null }>;
};

export async function fleetReplicationFixture(
  t: TestContext,
  options: {
    /** Commit-count retention window handed to the center (拟名 knob, see file header). */
    readonly retentionWindowCommits?: number;
    readonly replicationKeepaliveMs?: number;
    readonly now?: () => string;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-fleet-repl-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user"),
    stateRoot = path.join(root, "state"),
    keyFile = path.join(root, "tls.key"),
    certFile = path.join(root, "tls.crt"),
    emptyPath = path.join(root, "empty-path");
  const edgeChildren: ChildProcess[] = [];
  const trackedClosers: Array<() => void> = [];
  // Center-side transport faults, as the daemon's own listener would report them: a peer that drops
  // mid-stream is not one of these; an unreadable registry or a broken handler is.
  const transportErrors: { readonly nodeId: string | null; readonly error: unknown }[] = [];
  let center: FleetTlsCenter | null = null;
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  mkdirSync(emptyPath);
  const git = (...args: readonly string[]): string =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Replication Test");
  git("config", "user.email", "replication@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: replica\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git("add", "harness");
  git("commit", "-qm", "harness");
  registerDaemonRepo({ canonicalRoot: repo, repoId: replicationRepoId, userRoot, createConvenienceLinks: false });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(keyFile),
    cert = readFileSync(certFile),
    owners = await fleetNodeOwners({
      userRoot,
      owners: Object.fromEntries(replicationNodes.map((nodeId) => [nodeId, "person-owner"])),
      repoIds: [replicationRepoId],
      localPersonId: "person-local",
    }),
    host = await openDaemonHost({ daemonId: "replication-center", userRoot });
  await host.attachmentsSettled();
  t.after(async () => {
    for (const close of trackedClosers.splice(0)) close();
    // splice(0) empties the list, so the killed children are captured first; awaiting the now-empty
    // array (the bug this replaces) let a SIGKILLed edge outlive the test and race the tmpdir
    // removal below.
    const children = edgeChildren.splice(0);
    for (const child of children) child.kill("SIGKILL");
    // Bounded: a child that will not report its exit is named here, not waited on forever.
    for (const child of children)
      if (!(await waitForChildExit(child, 10_000)))
        t.diagnostic(`edge pid ${child.pid} did not report exit within 10s of SIGKILL`);
    try {
      await center?.close();
    } finally {
      try {
        await host.close();
      } finally {
        await owners.close();
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    }
  });
  const localAuth = {
      transportKind: "unix-socket" as const,
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary" as const,
      },
    },
    auth = owners.auth({ nodeId: replicationNodes[0] });
  const fixture = {
    root,
    repo,
    userRoot,
    stateRoot,
    certFile,
    cert,
    key,
    emptyPath,
    host,
    owners,
    auth,
    localAuth,
    transportErrors,
    ledgerPath: sqliteLedgerPath(repo),
    centerReader: () => makeTaskProjectionReader({ rootDir: repo }),
    /** The listening port of the currently open center (real or reopened). */
    centerPort: (): number => assertCenterOpen(center).port,
    track: (close: () => void) => {
      trackedClosers.push(close);
    },
    /** Opens (or re-opens after a close) the fleet TLS center for this host. */
    openCenter: async (): Promise<FleetTlsCenter> => {
      const opened = await listenFleetTls({
        host,
        stateRoot,
        ...fleetHostWriterOptions(userRoot, [replicationRepoId]),
        key,
        cert,
        replicaDiskQuotaBytes: replicaQuota,
        // 待对齐: 超窗重备份场景需要的保留窗口旋钮;A 落地 replication-slot 后核对名称。
        ...(options.retentionWindowCommits === undefined
          ? {}
          : { replicationRetentionWindowCommits: options.retentionWindowCommits }),
        ...(options.replicationKeepaliveMs === undefined
          ? {}
          : { replicationKeepaliveMs: options.replicationKeepaliveMs }),
        ...(options.now ? { now: options.now } : {}),
        authenticate: (nodeId: string, credential: string) =>
          (replicationNodes as readonly string[]).includes(nodeId) && credential === `secret-${nodeId}`,
        nodeOwner: owners.nodeOwner,
        verifyHuman: owners.verifyHuman,
        revokeDeviceSessions: (nodeId: string) => createIdentitySession(userRoot).revokeDeviceSessions(nodeId),
        onError: (entry) => transportErrors.push({ nodeId: entry.nodeId, error: entry.error }),
      });
      center = opened;
      return opened;
    },
    centerRun: (action: Record<string, unknown>, binding = localAuth) => host.run(replicationRepoId, action, binding),
    eventCount: (): number => fleetLedgerRevision(repo, replicationRepoId),
    /**
     * One authored task command from an edge, spoken directly on the new protocol: metadata for
     * the writer epoch, then the unchanged fleet.task.command/v1 write contract. This is the
     * "所有 authored 命令都发往中心单写队列" path of dec_9284BD61 §6.
     */
    edgeTaskCommand: async (
      nodeId: ReplicationNodeId,
      action: Record<string, unknown>,
      options: { readonly docChanges?: unknown } = {},
    ) => {
      const centerNow = assertCenterOpen(center);
      const peer = await rawPeer(fixture.track, centerNow.port, cert, nodeId, `secret-${nodeId}`);
      const metadata = await peer.request({
        schema: "fleet.repo.metadata.get/v1",
        messageId: "metadata",
        repoId: replicationRepoId,
        actionKind: String(action.kind),
        ...(typeof action.taskId === "string" ? { taskId: action.taskId } : {}),
      });
      if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error(JSON.stringify(metadata));
      const result = await peer.request({
        schema: "fleet.task.command/v1",
        messageId: "task",
        writerEpoch: metadata.writerEpoch,
        opId: randomUUID(),
        repoId: replicationRepoId,
        taskId: typeof action.taskId === "string" ? action.taskId : null,
        action,
        docChanges: options.docChanges ?? null,
        mirrorBaseCut: null,
      });
      peer.close();
      return result;
    },
    /** One document submission from an edge: staged upload, then fleet.doc.submit/v1. */
    edgeDocSubmit: async (
      nodeId: ReplicationNodeId,
      docPath: string,
      body: Buffer,
      baseBlobSha256: string | null = null,
    ) => {
      const centerNow = assertCenterOpen(center);
      const peer = await rawPeer(fixture.track, centerNow.port, cert, nodeId, `secret-${nodeId}`);
      const metadata = await peer.request({
        schema: "fleet.repo.metadata.get/v1",
        messageId: "metadata",
        repoId: replicationRepoId,
      });
      if (metadata.schema !== "fleet.repo.metadata.result/v1") throw new Error(JSON.stringify(metadata));
      const blob = {
          sha256: createHash("sha256").update(body).digest("hex"),
          size: body.length,
          mediaType: "text/markdown",
        },
        begun = await peer.request({
          schema: "fleet.upload.begin/v1",
          opId: "op-upload-test",
          messageId: "begin",
          repoId: replicationRepoId,
          content: blob,
        });
      if (begun.schema !== "fleet.upload.ready/v1") throw new Error(JSON.stringify(begun));
      const uploadId = begun.uploadId;
      for (let offset = 0; offset < body.length || offset === 0; offset += 64 * 1024) {
        const slice = body.subarray(offset, offset + 64 * 1024);
        await peer.request({
          schema: "fleet.upload.chunk/v1",
          opId: "op-upload-test",
          messageId: `chunk-${offset}`,
          uploadId,
          offset,
          dataBase64: slice.toString("base64"),
        });
        if (offset + 64 * 1024 >= body.length) break;
      }
      const finished = await peer.request({
        schema: "fleet.upload.finish/v1",
        opId: "op-upload-test",
        messageId: "finish",
        uploadId,
      });
      if (finished.schema !== "fleet.upload.result/v1") throw new Error(JSON.stringify(finished));
      const submitted = await peer.request({
        schema: "fleet.doc.submit/v1",
        opId: "op-fleet-test",
        messageId: "submit",
        repoId: replicationRepoId,
        executionId: null,
        writerEpoch: metadata.writerEpoch,
        baseLedgerSha: metadata.baseLedgerSha,
        changes: [
          {
            path: docPath,
            baseBlobSha256,
            policyId: "markdown-body-replaceable/v1",
            candidate: { ref: finished.descriptor.ref, ...blob },
          },
        ],
      });
      peer.close();
      return submitted;
    },
    /** Spawns (or re-spawns after a kill) one edge replica process with its own roots. */
    startEdge: (
      nodeId: ReplicationNodeId,
      edgeOptions: {
        readonly killpoints?: readonly string[];
        readonly killOnSchema?: string;
        readonly holdAcks?: boolean;
        readonly retry?: boolean;
        /** Overrides the center port, pointing the edge at a test-local fake center. */
        readonly port?: number;
      } = {},
    ): EdgeProcess => {
      assert.ok(center || edgeOptions.port, "open the center (or pass a fake center port) before starting edges");
      const edgeRoot = path.join(root, `${nodeId}-edge`),
        userRootOfEdge = path.join(root, `${nodeId}-user`),
        mirrorRoot = path.join(edgeRoot, "mirror"),
        viewRoot = path.join(edgeRoot, "view");
      mkdirSync(mirrorRoot, { recursive: true });
      mkdirSync(viewRoot, { recursive: true });
      const config = {
        nodeId,
        port: edgeOptions.port ?? center.port,
        caFile: certFile,
        servername: "localhost",
        credential: `secret-${nodeId}`,
        repoId: replicationRepoId,
        mirrorRoot,
        ...(edgeOptions.killpoints ? { killpoints: edgeOptions.killpoints } : {}),
        ...(edgeOptions.killOnSchema ? { killOnSchema: edgeOptions.killOnSchema } : {}),
        ...(edgeOptions.holdAcks === undefined ? {} : { holdAcks: edgeOptions.holdAcks }),
        ...(edgeOptions.retry === undefined ? {} : { retry: edgeOptions.retry }),
      };
      const configFile = path.join(root, `edge-config-${nodeId}-${randomUUID()}.json`);
      writeFileSync(configFile, JSON.stringify(config));
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dirname, "fixtures/fleet-replication-edge-child.mjs"), configFile],
        { env: { ...process.env, PATH: emptyPath }, stdio: ["pipe", "pipe", "pipe"] },
      );
      edgeChildren.push(child);
      const events: EdgeChildEvent[] = [];
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          events.push(JSON.parse(line) as EdgeChildEvent);
        }
      });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      // The child's own terminal signal, readable synchronously so a state wait can stop on it.
      // `exitedNow` is separate from `exitCode` because a SIGKILLed child reports code null.
      let exitCode: number | null = null,
        exitedNow = false;
      const exited = new Promise<{ code: number | null }>((resolve) => {
        child.on("close", (code) => {
          exitCode = code;
          exitedNow = true;
          resolve({ code });
        });
      });
      const exitedBecause = (): string | null =>
        exitedNow
          ? `edge ${nodeId} exited (code ${String(exitCode)}) before reaching the awaited state; ` +
            `events=${JSON.stringify(events).slice(0, 800)} stderr=${stderr.slice(0, 400)}`
          : null;
      t.diagnostic(`edge ${nodeId} spawned (pid ${child.pid})`);
      return {
        nodeId,
        root: edgeRoot,
        userRoot: userRootOfEdge,
        mirrorRoot,
        viewRoot,
        events,
        waitForEvent: (kind, timeoutMs = 30_000) => {
          const found = events.find((event) => event.event === kind);
          if (found) return Promise.resolve(found);
          const deadline = performance.now() + timeoutMs;
          return new Promise<EdgeChildEvent>((resolve, reject) => {
            const poll = () => {
              const match = events.find((event) => event.event === kind);
              if (match) resolve(match);
              else if (performance.now() > deadline)
                reject(
                  new Error(
                    // Read at failure time: the state that timed out, not the state when the wait began.
                    `edge ${nodeId} did not report ${kind}; events=${JSON.stringify(events).slice(0, 800)} stderr=${stderr.slice(0, 400)}`,
                  ),
                );
              else setTimeout(poll, 10);
            };
            poll();
          });
        },
        lastEvent: (kind) => [...events].reverse().find((event) => event.event === kind),
        waitForWhere: (predicate, label, timeoutMs = 30_000) =>
          waitForState(
            () => events.some(predicate),
            // A thunk, not a string: the events are read when the wait fails, not when it starts.
            () =>
              `edge ${nodeId}: ${label}; events=${JSON.stringify(events).slice(0, 800)} stderr=${stderr.slice(0, 400)}`,
            timeoutMs,
            exitedBecause,
          ),
        control: (line) => child.stdin.write(`${JSON.stringify(line)}\n`),
        kill: () => child.kill("SIGKILL"),
        exited,
      };
    },
  };
  return fixture;
}

export type FleetReplicationFixture = Awaited<ReturnType<typeof fleetReplicationFixture>>;

function assertCenterOpen(center: FleetTlsCenter | null): FleetTlsCenter {
  assert.ok(center, "open the center before sending edge commands");
  return center;
}

/** A raw TLS peer for the replication conversation: the session hello uses the unchanged session
 * contract, every later frame on this conversation is a replica.* replication frame. */
export async function replicationPeer(
  track: (close: () => void) => void,
  port: number,
  ca: Buffer,
  nodeId: string,
  credential: string,
) {
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    const candidate = connect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => resolve(candidate));
    candidate.once("error", reject);
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  track(() => socket.destroy());
  // A center that cuts this session destroys the socket; the close event below is the signal
  // cut cases assert on, an error here would instead fail the run.
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const nextLine = () =>
      lines.length ? Promise.resolve(lines.shift()!) : new Promise<string>((resolve) => waiters.push(resolve)),
    next = async () => parseReplicationFrame(await nextLine()),
    request = async (frame: ReplicationFrame) => {
      socket.write(serializeReplicationFrame(frame));
      return next();
    },
    raw = async (frame: Record<string, unknown>) => {
      socket.write(`${JSON.stringify(frame)}\n`);
      return next();
    },
    sendRawBytes = (bytes: Buffer) => socket.write(bytes);
  socket.write(
    serializeFleetFrame({
      schema: "fleet.session.hello/v1",
      messageId: "hello",
      protocolVersion: { major: 1, minor: 0 },
      nodeId,
      credential,
      accessToken: `device-token-${nodeId}`,
    }),
  );
  const ready = parseFleetFrame(await nextLine());
  if (ready.schema === "fleet.error/v1") throw new Error(ready.code);
  return { request, raw, sendRawBytes, receive: next, closed, socket, close: () => socket.destroy() };
}

/**
 * A test-local TLS "center" the edge child can be pointed at (startEdge port override). It speaks
 * the same session handshake, then hands every decoded frame to `handle`, which decides what the
 * fake center sends back. This is the seam for fault injection the real center cannot produce on
 * purpose: corrupted package bytes, unsupported projection schema, replayed or gapped records.
 */
export async function fakeReplicationCenter(
  t: TestContext,
  fixture: FleetReplicationFixture,
  handle: (frame: ReplicationFrame, send: (frame: ReplicationFrame) => void) => void | Promise<void>,
): Promise<{
  port: number;
  received: ReplicationFrame[];
  counts: () => Record<string, number>;
  waitSocketCount: (count: number) => Promise<void>;
}> {
  const received: ReplicationFrame[] = [];
  const sockets = new Set<TLSSocket>();
  const server = createServer({ key: fixture.key, cert: fixture.cert }, (socket: TLSSocket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "",
      sessionReady = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!sessionReady) {
          const hello = parseFleetFrame(line);
          if (hello.schema !== "fleet.session.hello/v1") throw new Error("fake center expects the session hello first");
          socket.write(
            serializeFleetFrame({
              schema: "fleet.session.ready/v1",
              messageId: "ready",
              inReplyTo: hello.messageId,
              sessionId: "fake-session",
              maxFrameBytes: 96 * 1024,
              chunkBytes: 64 * 1024,
            }),
          );
          sessionReady = true;
          continue;
        }
        const frame = parseReplicationFrame(line);
        received.push(frame);
        const pending: ReplicationFrame[] = [],
          bufferStartResponse = frame.type === "replica.start",
          write = (out: ReplicationFrame) => socket.write(serializeReplicationFrame(out)),
          send = (out: ReplicationFrame) => {
            if (bufferStartResponse) pending.push(out);
            else write(out);
          };
        void Promise.resolve(handle(frame, send))
          .then(() => {
            if (frame.type === "replica.failure") {
              socket.end();
              return;
            }
            if (!bufferStartResponse) return;
            if (pending[0]?.type !== "replica.reject")
              write({
                type: "replica.accept",
                centerBuildCommit: null,
                taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
              });
            for (const out of pending) write(out);
          })
          .catch((error) => {
            socket.destroy(error instanceof Error ? error : new Error(String(error)));
          });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "fake center must be listening");
  fixture.track(() => server.close());
  t.after(() => server.close());
  return {
    port: address.port,
    received,
    counts: () => {
      const tally: Record<string, number> = {};
      for (const frame of received) tally[frame.type] = (tally[frame.type] ?? 0) + 1;
      return tally;
    },
    waitSocketCount: (count) => waitForState(() => sockets.size === count, `fake center to hold ${count} sockets`),
  };
}

/** sqlite_schema rows (tables + indexes) of one database file, the shared-reader identity probe. */
export function sqliteObjects(dbPath: string): { type: string; name: string; tbl_name: string; sql: string }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  } finally {
    db.close();
  }
}

/** EXPLAIN QUERY PLAN rows for one statement; the no-full-scan probe asserts on these. */
export function queryPlanRows(dbPath: string, sql: string, params: readonly unknown[] = []): { detail: string }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string };
  } finally {
    db.close();
  }
}

/**
 * Bounded state wait: polls the observed condition without a wall-clock sleep schedule.
 *
 * `label` may be a thunk. A caller that embeds mutable state (the child's events, its stderr) must
 * pass one: a string is formatted at the call, so a timeout would report the state from before the
 * wait instead of the state that actually made it time out.
 *
 * `failure` is the observed process's own terminal signal. When it reports one the wait stops at
 * once and names it, instead of spending the rest of the budget on a clock: a child that already
 * died will never reach the state being polled.
 */
export async function waitForState(
  check: () => boolean | Promise<boolean>,
  label: string | (() => string),
  timeoutMs = 30_000,
  failure?: () => string | null,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await check()) return;
    const failed = failure?.();
    if (failed !== null && failed !== undefined) throw new Error(failed);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error(`timed out waiting for ${typeof label === "function" ? label() : label}`);
}

/**
 * Seeds the center with the data classes a complete mirror must carry: a task with a realized
 * plan document, an authored markdown note, a started execution, a runtime installation event
 * and task progress with evidence.
 */
export async function seedCenterData(
  fixture: FleetReplicationFixture,
  task: { readonly taskId: string; readonly executionId: string; readonly title: string },
): Promise<{ readonly planPath: string }> {
  const created = await fixture.centerRun({ kind: "task-create", taskId: task.taskId, title: task.title });
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  const planPath = await realizeTaskPlanFixture(
    fixture.repo,
    String((created as Record<string, unknown>).packagePath),
    (planPath) => fixture.centerRun({ kind: "doc-submit", paths: [planPath] }),
    task.title,
  );
  const started = await fixture.centerRun({
    kind: "task-start",
    taskId: task.taskId,
    executionId: task.executionId,
  });
  assert.equal(started.outcome, "applied", JSON.stringify(started));
  const installation = await fixture.host.runtimeIngress(
    replicationRepoId,
    {
      kind: "event",
      type: "runtime_installation_observed",
      opId: `installation-${task.taskId}`,
      payload: {
        installationId: `installation-${task.taskId}`,
        kindId: "codex",
        protocolFamily: "app-server",
        hostRef: "host:center",
        version: "1",
        discoverySource: "wrapper",
        capabilities: [],
      },
    },
    fixture.owners.auth({ nodeId: replicationNodes[0] }),
  );
  assert.equal(installation.outcome, "applied", JSON.stringify(installation));
  return { planPath };
}

/** True when the child reports its exit before the bound; the caller names it instead of hanging. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}
