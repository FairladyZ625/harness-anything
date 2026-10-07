// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fleetNodeClaimFixture } from "./fleet-node-claim.fixtures.ts";
import { fleetEdgeHostFixture } from "./fleet-edge-host.fixture.ts";
import { localAuthFixture } from "./fleet-tls-session.fixture.ts";
import { runFleetReplicaPullClient } from "../src/fleet/edge.ts";
import { repositoryReadData } from "../src/protocol/repository-read-frame.ts";

// The actual GUI JSON-RPC methods; the edge workspace deliberately has no task files.
test(
  "GUI documents, binary bytes, workspace events and CI read the same replica cut offline",
  { timeout: 180_000 },
  async (t) => {
    const f = await fleetNodeClaimFixture(t, undefined, undefined, undefined, undefined, true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = f.owners.keycloak.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    assert.equal(
      (await f.command("center-node", { kind: "task-create", taskId: "gui-content", title: "GUI content" })).outcome,
      "applied",
    );
    assert.equal((await f.command("center-node", { kind: "task-start", taskId: "gui-content" })).outcome, "applied");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]);
    writeFileSync(path.join(f.repo, "diagram.png"), bytes);
    const added = await f.host.run(
      "lease-repo",
      { kind: "task-artifact-add", taskId: "gui-content", source: "diagram.png", destination: "diagram.png" },
      localAuthFixture(),
    );
    assert.equal(added.outcome, "applied", JSON.stringify(added));
    const e = await fleetEdgeHostFixture(t, f);
    const replica = f.host.replica("lease-repo");
    replica.activate();
    await replica.waitForCut(f.eventCount());
    await runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: 64 * 1024 * 1024 });
    const scope = await f.host.read(
      "lease-repo",
      "repo.workspace.scope.read",
      { rootTaskId: "gui-content" },
      localAuthFixture(),
    );
    const events = await f.host.read(
      "lease-repo",
      "observe.tail",
      { kind: "events", direction: "history" },
      localAuthFixture(),
    );
    const documents = await f.host.read(
      "lease-repo",
      "repo.tasks.documents.list",
      { taskId: "gui-content" },
      localAuthFixture(),
    );
    await f.center.close();
    let id = 10;
    const read = async (method: string, payload: Record<string, unknown>) => {
      const response = await e.rpc.handle({
        jsonrpc: "2.0",
        id: id++,
        method,
        params: { repo: { repoId: "lease-repo" }, payload },
      });
      assert.ok(response && !Array.isArray(response) && "result" in response, JSON.stringify(response));
      assert.notEqual((response.result as { ok?: boolean }).ok, false, JSON.stringify(response));
      assert.ok((response.result as { cut?: unknown }).cut, `${method} lacks replica cut`);
      return repositoryReadData(response.result) as Record<string, unknown>;
    };
    const listed = await read("repo.tasks.documents.list", { taskId: "gui-content" });
    assert.deepEqual(listed.documents, documents.documents);
    const binary = await read("repo.tasks.document.read", { taskId: "gui-content", path: "artifacts/diagram.png" });
    assert.equal(binary.contentKind, "binary");
    assert.deepEqual(Buffer.from(String(binary.bytes), "base64"), bytes);
    assert.equal(binary.uncommitted, false);
    assert.deepEqual(await read("repo.workspace.scope.read", { rootTaskId: "gui-content" }), scope);
    const observed = await read("observe.tail", { kind: "events", direction: "history" });
    assert.deepEqual(observed.items, events.items);
    assert.ok((observed.items as unknown[]).length > 0);
    const explanation = await read("repo.entity.actions.explain", {
      schema: "entity-action-explain-request/v1",
      mode: "object",
      entityKind: null,
      refs: ["task/gui-content"],
    });
    assert.equal(explanation.mode, "object", JSON.stringify(explanation));
    assert.equal((explanation.subjects as unknown[]).length, 1);
    const ci = await read("repo.ci.observatory.read", { window: 10 });
    assert.deepEqual(ci.runs, []);
    const decisions = await read("repo.decisions.list", { projection: "full" });
    assert.deepEqual(decisions.decisions, []);
    globalThis.fetch = async () => {
      throw new Error("Keycloak fixture offline");
    };
    const denied = await e.rpc.handle({
      jsonrpc: "2.0",
      id: id++,
      method: "repo.entity.actions.explain",
      params: {
        repo: { repoId: "lease-repo" },
        payload: {
          schema: "entity-action-explain-request/v1",
          mode: "object",
          entityKind: null,
          refs: ["task/gui-content"],
        },
      },
    });
    assert.match(JSON.stringify(denied), /keycloak_unavailable/);
    t.diagnostic(
      `offline GUI cut=${String(listed.watermark)}, documents=${documents.documents.length}, events=${(observed.items as unknown[]).length}, binaryBytes=${bytes.byteLength}`,
    );
  },
);
