// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonlTail, singleJsonlFile } from "../src/observe-jsonl-tail.ts";
import { dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { startDaemon, type RunningDaemon } from "../src/runtime.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";

for (const filtered of [false, true]) {
  for (const leadingBlank of [false, true]) {
    test(`backward JSONL scan consumes a leading newline once (filtered=${filtered}, fileStart=${leadingBlank})`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-jsonl-boundary-")),
        file = path.join(root, "records.jsonl"),
        // The final 64 KiB window starts with the preceding record's newline.
        // At that boundary a negative lastIndexOf offset searches from the end again.
        record = JSON.stringify({ seq: 1, body: "" }),
        tail = `${JSON.stringify({ seq: 1, body: "x".repeat(65_534 - record.length) })}\n`,
        seen = new Set<unknown>();
      writeFileSync(file, `${leadingBlank ? "\n" : '{"seq":0}\n'}${tail}`);
      try {
        const started = performance.now(),
          page = await readJsonlTail(
            "dispatch",
            "history",
            undefined,
            () => singleJsonlFile(file),
            (row) => {
              // Turns an otherwise unbounded CPU loop into a deterministic assertion failure.
              assert.equal(seen.has(row.seq), false, `record ${String(row.seq)} was parsed twice`);
              seen.add(row.seq);
              return filtered ? null : row;
            },
          );
        console.log(
          `JSONL boundary: filtered=${filtered} fileStart=${leadingBlank} elapsedMs=${performance.now() - started}`,
        );
        assert.equal(page.done, true);
        assert.deepEqual([...seen], leadingBlank ? [1] : [1, 0]);
        assert.deepEqual(
          page.items.map((row) => row.seq),
          filtered ? [] : leadingBlank ? [1] : [0, 1],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("an aligned dispatch history request leaves an isolated daemon responsive through shutdown", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-jsonl-daemon-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "jsonl-drain",
    dispatchId = "dispatch_0123456789abcdef01234567",
    opened = Promise.withResolvers<void>(),
    closing = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let daemon: RunningDaemon | undefined;
  mkdirSync(rootDir);
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "JSONL Test"],
    ["config", "user.email", "jsonl@example.invalid"],
    ["commit", "--allow-empty", "--quiet", "-m", "fixture base"],
  ])
    execFileSync("git", ["-C", rootDir, ...args]);
  signInPolicyTestUser(userRoot, "jsonl-observer", [repoId], "admin");
  registerBootstrappedDaemonRepo({ canonicalRoot: rootDir, repoId, userRoot, createConvenienceLinks: false });
  try {
    const started = await startDaemon({
      daemonId: repoId,
      userRoot,
      openCell: async (input) => {
        const cell = await openBootstrappedRepoCell(input);
        opened.resolve();
        return {
          ...cell,
          close: async () => {
            closing.resolve();
            await release.promise;
            await cell.close();
          },
        };
      },
    });
    assert.ok("stop" in started);
    daemon = started;
    await opened.promise;
    openDispatchStream(rootDir, {
      dispatchId,
      taskId: "task-jsonl",
      executionId: "execution-jsonl",
      runtimeSessionId: "runtime-jsonl",
      instanceId: "test",
      kindId: "codex",
      startedAt: "2026-11-03T13:00:00.000Z",
    });
    const record = { kind: "provider_event", event: { type: "ignored" }, body: "" },
      tail = { ...record, body: "x".repeat(65_534 - JSON.stringify(record).length) };
    appendFileSync(dispatchStreamPath(rootDir, dispatchId), `${JSON.stringify(tail)}\n`);
    const began = performance.now(),
      page = await requestDaemonJsonRpcAt(daemon.endpoint, "observe.tail", {
        repo: { repoId },
        payload: { kind: "dispatch", direction: "history", dispatchId },
      });
    assert.equal(page.ok, true, JSON.stringify(page));
    assert.equal(page.done, true);
    assert.deepEqual(page.items, []);
    const readMs = performance.now() - began,
      stopBegan = performance.now(),
      stopped = daemon.stop();
    await closing.promise;
    const status = await requestDaemonJsonRpcAt(daemon.endpoint, "daemon.status", {});
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.match(String(status.summary), /Stopping: draining \d+ queued write\(s\), \d+ attaching/u);
    const refused = await requestDaemonJsonRpcAt(daemon.endpoint, "observe.tail", {
      repo: { repoId },
      payload: { kind: "dispatch", direction: "history", dispatchId },
    });
    assert.equal(refused.code, "daemon_stopping", JSON.stringify(refused));
    release.resolve();
    await stopped;
    console.log(`isolated daemon: historyMs=${readMs} shutdownMs=${performance.now() - stopBegan}`);
  } finally {
    release.resolve();
    await daemon?.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});
