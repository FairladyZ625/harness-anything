// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../src/daemon-host/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/daemon-host/protocol/version.ts";
import { revokeTestPolicyActions, signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";

const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: {
    ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary",
  },
} as const;

type Page = {
  readonly events: readonly CanonicalEventV1[];
  readonly nextAfterRevision: number;
  readonly headRevision: number;
  readonly hasMore: boolean;
};

test(
  "canonical event reads resume by revision after restart and wake on a committed write",
  { timeout: 40_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-canonical-event-subscription-")),
      rootDir = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "event-subscription",
      open = () => openDaemonHost({ daemonId: "event-subscription", userRoot });
    signInPolicyTestUser(userRoot, "owner", [repoId], "admin");
    let host: Awaited<ReturnType<typeof open>> | undefined;
    let rpc: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      host = await open();
      assert.equal(
        (await host.bootstrap({ rootDir, repoId, personId: "owner", displayName: "Owner" }, auth)).outcome,
        "applied",
      );
      rpc = await connect(host, repoId);
      const append = async (suffix: string) => {
        const result = await host!.run(repoId, { kind: "task-create", taskId: `task-${suffix}`, title: suffix }, auth);
        assert.equal(result.outcome, "applied", JSON.stringify(result));
        return result.opId;
      };
      await append("first");
      await append("second");
      const first = await rpc.page({ afterRevision: 0, limit: 2 });
      assert.equal(first.events.length, 2);
      assert.equal(first.hasMore, true);
      rpc.close();
      await host.close();
      host = await open();
      await host.attachmentsSettled();
      rpc = await connect(host, repoId);
      await append("third");

      const consumed = [...first.events];
      let cursor = first.nextAfterRevision;
      let page: Page;
      do {
        page = await rpc.page({ afterRevision: cursor, limit: 2 });
        assert.ok(page.nextAfterRevision > cursor);
        consumed.push(...page.events);
        cursor = page.nextAfterRevision;
      } while (page.hasMore);
      assert.equal(cursor, page.headRevision);
      const store = makeTaskEventReader({ rootDir, repoId });
      try {
        assert.deepEqual(consumed, store.read().events);
      } finally {
        await store.drain();
      }
      assert.equal(new Set(consumed.map(({ opId }) => opId)).size, consumed.length);
      assert.deepEqual(await rpc.page({ afterRevision: cursor, limit: 500, waitMs: 10 }), {
        schema: "canonical-event-page/v1",
        ok: true,
        repoId,
        events: [],
        nextAfterRevision: cursor,
        headRevision: cursor,
        hasMore: false,
      });
      const invalid = await rpc.request({ afterRevision: cursor + 1, limit: 1 });
      assert.equal(invalid?.code, "invalid_cursor", JSON.stringify(invalid));
      for (const payload of [
        { afterRevision: -1, limit: 1 },
        { afterRevision: 0, limit: 0 },
        { afterRevision: 0, limit: 501 },
        { afterRevision: 0, limit: 1, waitMs: 25_001 },
      ])
        assert.equal(
          (await rpc.request(payload))?.code,
          payload.afterRevision < 0 ? "invalid_cursor" : "invalid_request",
        );

      const client = rpc;
      await t.test("a canonical commit wakes the parked read", { timeout: 5_000 }, async () => {
        const started = performance.now();
        const waiting = client.page({ afterRevision: cursor, limit: 2, waitMs: 15_000 });
        // The parked read leaves both the write queue and reader workers available.
        const [, opId] = await Promise.all([client.page({ afterRevision: cursor, limit: 2 }), append("wake")]);
        const wake = await waiting;
        assert.equal(wake.events[0]?.opId, opId);
        console.log(`CANONICAL_EVENT_WAKE_MS ${(performance.now() - started).toFixed(1)}`);
      });

      revokeTestPolicyActions("owner", repoId, ["repository-read"]);
      const denied = await rpc.request({ afterRevision: 0, limit: 1 });
      assert.equal(denied.ok, false, JSON.stringify(denied));
      assert.equal(denied.code, "authorization_denied", JSON.stringify(denied));
      assert.equal(Object.hasOwn(denied, "events"), false);
    } finally {
      rpc?.close();
      await host?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  },
);

async function connect(host: Awaited<ReturnType<typeof openDaemonHost>>, repoId: string) {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  let id = 0;
  await server.handle({
    jsonrpc: "2.0",
    id: ++id,
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion },
  });
  const request = async (payload: Record<string, number>) => {
    const response = await server.handle({
      jsonrpc: "2.0",
      id: ++id,
      method: "repo.events.read",
      params: { repo: { repoId }, payload },
    });
    assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
    return response.result as Record<string, unknown>;
  };
  return {
    close: server.close,
    request,
    page: async (payload: Record<string, number>) => {
      const result = await request(payload);
      assert.equal(result.schema, "canonical-event-page/v1", JSON.stringify(result));
      return result as unknown as Page;
    },
  };
}
