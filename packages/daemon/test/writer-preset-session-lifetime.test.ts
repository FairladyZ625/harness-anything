// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import { localDefaultBinding } from "../src/daemon-host-binding.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoWriterCapabilityResultV1, RepoWriterRequestV1 } from "../src/repo-writer-protocol.ts";
import { openWriterSupervisor } from "../src/writer-supervisor.ts";

for (const ended of [false, true]) {
  test(`preset admission retains its original session after receipt (ended=${ended})`, async () => {
    const writer = new FakeWriter(),
      opening = openWriterSupervisor(
        { repoId: workspaceId("preset-session"), rootDir: canonicalRoot(process.cwd()), ownerId: "test" },
        { createWorker: () => writer as unknown as Worker },
      );
    writer.emit("message", { schema: "harness-repo-writer-status/v1", protocolVersion: 1, kind: "ready" });
    const supervisor = await opening;
    let token = "old-token",
      calls = 0;
    const binding = localDefaultBinding({
      transportKind: "unix-socket",
      oidcPrincipal: {
        personId: "original",
        subject: "original",
        expiresAt: Date.now() + 60_000,
        accessToken: token,
        authority: { url: "http://127.0.0.1:1", realm: "test", clientId: "test" },
      },
      localSessionAccessToken: async () => {
        calls += 1;
        if (ended) throw Object.assign(new Error("original session ended"), { code: "authentication_required" });
        return token;
      },
    });
    try {
      await supervisor.request("presetRun", { action: { kind: "preset-run-start" } }, binding);
      const admitted = writer.lastRequest!;
      assert.equal(supervisor.status().queueDepth, 0, "admission request is finished");
      token = "live-token";
      const result = await writer.call("currentAccessToken", admitted.requestId);
      assert.equal(result.outcome, ended ? "error" : "ok");
      if (ended) assert.equal(result.error?.code, "authentication_required");
      else assert.equal(result.value, "live-token");
      assert.equal(calls, 1, "resolves the bound session once without retry");
      await writer.call("releaseCurrentAccessToken", admitted.requestId);
      const released = await writer.call("currentAccessToken", admitted.requestId);
      assert.equal(released.outcome, "error");
      assert.match(released.error?.message ?? "", /resolver is unavailable/u);
      assert.equal(calls, 1, "terminal release drops the resolver");

      await supervisor.request("presetRun", { action: { kind: "preset-run-status" } }, binding);
      const status = await writer.call("currentAccessToken", writer.lastRequest!.requestId);
      assert.equal(status.outcome, "error", "status requests do not retain a session");
    } finally {
      await supervisor.close();
    }
  });
}

class FakeWriter extends EventEmitter {
  lastRequest?: RepoWriterRequestV1;
  replies = new Map<string, (result: RepoWriterCapabilityResultV1) => void>();
  sequence = 0;

  postMessage(message: RepoWriterRequestV1 | RepoWriterCapabilityResultV1): void {
    if (message.schema === "harness-repo-writer-capability-result/v1") {
      this.replies.get(message.callId)!(message);
      this.replies.delete(message.callId);
      return;
    }
    this.lastRequest = message;
    this.emit("message", {
      schema: "harness-repo-writer-receipt/v1",
      protocolVersion: 1,
      requestId: message.requestId,
      outcome: "ok",
      value: { outcome: "started", phase: "admitted" },
    });
  }

  call(capability: string, payload: string): Promise<RepoWriterCapabilityResultV1> {
    const callId = String(++this.sequence);
    return new Promise((resolve) => {
      this.replies.set(callId, resolve);
      this.emit("message", { schema: "harness-repo-writer-capability-call/v1", callId, capability, payload });
    });
  }

  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
}
