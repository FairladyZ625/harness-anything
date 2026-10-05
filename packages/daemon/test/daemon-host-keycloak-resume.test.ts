// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "../src/daemon-host.ts";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";
import { policyTestCenter, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";

// The daemon-side shape of the 2026-10-05 build-superseded handoff: a successor daemon consults
// the identity center while the managed center's own resume is still running, and the
// not-yet-started center refuses the connection ("TypeError: fetch failed", then HTTP 503). The
// consultation must wait for the resume — a center still starting is a slow daemon start, never a
// broken repo.
test("a binding consults the identity center only after the managed resume has settled", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-rbac-resume-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    rbacConfig = path.join(userRoot, "rbac", "config.json"),
    // One URL for the whole test, like the managed center across a restart: the same address is
    // refused while the center resumes and answers once the resume settles.
    center = await gatedCenter((await policyTestCenter()).url);
  rosterRepo(rootDir, "rbac-resume");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "rbac-resume", userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", ["rbac-resume"], "admin");
  writeFileSync(rbacConfig, JSON.stringify({ url: center.url, realm: "harness" }));
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    }),
    host = await openDaemonHost({
      daemonId: "rbac-resume",
      userRoot,
      managedRbac: { run: async () => ({ ok: true }), resume: () => resumeGate, stop: async () => ({ ok: true }) },
    });
  try {
    await host.attachmentsSettled();
    // A repository with no runtimes to adopt attaches without consulting the center.
    assert.equal(host.status().repos.find((repo) => repo.repoId === "rbac-resume")?.state, "attached");
    let settled: unknown = null;
    const pending = host.run("rbac-resume", { kind: "task-list" }, auth).then((receipt) => {
      settled = receipt;
      return receipt;
    });
    for (let turn = 0; turn < 20 && settled === null; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, null, "the binding must park behind the identity center's resume, not fail its first fetch");
    center.release();
    releaseResume();
    const receipt = await withHangGuard(pending);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  } finally {
    releaseResume();
    center.release();
    await host.close();
    await center.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

// A resume that cannot bring the center back must not park consultations forever: the wait is for
// the startup transient only, and a genuinely down center still fails every fetch honestly.
test("a failed resume does not swallow the identity center's real failure", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-rbac-resume-failed-")),
    userRoot = path.join(parent, "user"),
    rootDir = path.join(parent, "repo"),
    center = await gatedCenter((await policyTestCenter()).url),
    records: Record<string, unknown>[] = [];
  rosterRepo(rootDir, "rbac-resume-failed");
  registerDaemonRepo({ canonicalRoot: rootDir, repoId: "rbac-resume-failed", userRoot, createConvenienceLinks: false });
  signInPolicyTestUser(userRoot, "writer", ["rbac-resume-failed"], "admin");
  writeFileSync(path.join(userRoot, "rbac", "config.json"), JSON.stringify({ url: center.url, realm: "harness" }));
  const host = await openDaemonHost({
    daemonId: "rbac-resume-failed",
    userRoot,
    recordLifecycle: (record) => records.push(record),
    managedRbac: {
      run: async () => ({ ok: true }),
      resume: () => Promise.reject(new Error("the managed center did not start")),
      stop: async () => ({ ok: true }),
    },
  });
  try {
    await host.attachmentsSettled();
    const receipt = await withHangGuard(host.run("rbac-resume-failed", { kind: "task-list" }, auth));
    assert.notEqual(receipt.outcome, "applied");
    assert.equal(
      records.some((record) => record.event === "rbac_resume_failed"),
      true,
      "the failed resume must be recorded in the lifecycle log",
    );
  } finally {
    center.release();
    await host.close();
    await center.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

/** The realm's address behind a gate: connections are refused until the center "finishes resuming". */
async function gatedCenter(upstreamUrl: string): Promise<{
  readonly url: string;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}> {
  let ready = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    if (!ready) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(new URL(upstreamUrl).port), "127.0.0.1");
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  // A fixture that fails before its teardown registers must not hold the test process open.
  server.unref();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    release: () => {
      ready = true;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function withHangGuard<T>(pending: Promise<T>): Promise<T> {
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("the daemon host run did not settle within the 10s hang guard")), 10_000),
    ),
  ]);
}
