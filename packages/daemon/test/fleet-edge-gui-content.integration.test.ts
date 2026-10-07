// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    assert.equal(
      (await f.host.run("lease-repo", { kind: "vertical-declaration-migrate" }, localAuthFixture())).outcome,
      "applied",
    );
    const source = path.join(f.repo, "research", "edge-content");
    mkdirSync(path.join(source, "reserved"), { recursive: true });
    writeFileSync(path.join(source, "README.md"), "# Owned replica bytes\n");
    execFileSync("git", ["-C", f.repo, "add", "research/edge-content"]);
    execFileSync("git", ["-C", f.repo, "commit", "-qm", "add entity source"]);
    const entityKind = "entity-kind/KND-3b7e2c9a1d5f6e8c0a4b2d3f5e7c9a16";
    const imported = await f.host.run(
      "lease-repo",
      { kind: "entity-import", entityKind, locator: "research/edge-content", expectedVersion: 0 },
      localAuthFixture(),
    );
    assert.equal(imported.outcome, "applied", JSON.stringify(imported));
    const entityId = JSON.parse(String(imported.evidence)).preview.entityId as string;
    rmSync(source, { recursive: true });
    const expectedContent = await f.host.read(
      "lease-repo",
      "repo.entity.content.read",
      { entityKind, entityId },
      localAuthFixture(),
    );
    assert.equal(expectedContent.outcome, "directory");
    assert.ok(expectedContent.entries.some((entry) => entry.path === "reserved" && entry.directory));
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
    const plan = await f.host.read(
      "lease-repo",
      "repo.tasks.document.read",
      { taskId: "gui-content", path: "task_plan.md" },
      localAuthFixture(),
    );
    const healthy = (await e.host.run(
      "lease-repo",
      { kind: "doctor-health" },
      localAuthFixture(),
    )) as unknown as Record<string, unknown>;
    assert.equal(healthy.failureCode, null, JSON.stringify(healthy));
    assert.equal(healthy.lag, 0);
    assert.deepEqual(healthy.currentCut, healthy.centerCut);
    assert.equal(typeof healthy.authorizationShapeDigest, "string");
    assert.equal(typeof healthy.schemaGeneration, "number");
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
    for (const kind of ["event-show"]) {
      const raw = await e.command({ kind, opId: "absent" });
      assert.equal(raw.code, "replica_unavailable", JSON.stringify(raw));
    }
    const receiptUnavailable = await e.host.run(
      "lease-repo",
      { kind: "receipt-show", opId: "absent" },
      localAuthFixture(),
    );
    assert.equal(receiptUnavailable.code, "replica_unavailable", JSON.stringify(receiptUnavailable));
    const eventPage = await e.command({ kind: "event-list", limit: 2 });
    assert.equal(eventPage.ok, true, JSON.stringify(eventPage));
    const eventData = JSON.parse(String(eventPage.evidence));
    assert.equal(eventData.rows.length, 2);
    assert.equal(eventData.hasMore, true);
    const reviewed = await e.command({ kind: "task-review", taskId: "gui-content" });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    const planPath = plan.repositoryPath.replace(/^harness\//, "");
    const shown = await e.command({ kind: "doc-show", path: planPath });
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(shown.evidence, plan.body, JSON.stringify(shown));
    const missing = await e.command({
      kind: "doc-show",
      path: planPath.replace("task_plan.md", "artifacts/missing.md"),
    });
    assert.equal(missing.code, "document_not_found", JSON.stringify(missing));
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
    const viewDir = path.join(e.viewRoot, "repos", "lease-repo", "views", "node-one");
    writeFileSync(path.join(viewDir, "read-model.sqlite"), "damaged SQLite cache");
    await read("repo.tasks.documents.list", { taskId: "gui-content" });
    const rebuilt = (await e.host.run(
      "lease-repo",
      { kind: "doctor-health" },
      localAuthFixture(),
    )) as unknown as Record<string, unknown>;
    assert.equal(rebuilt.rebuildCount, 1, JSON.stringify(rebuilt));
    await assert.rejects(
      runFleetReplicaPullClient({ ...f.peer("node-one"), viewRoot: e.viewRoot, diskQuotaBytes: 64 * 1024 * 1024 }),
    );
    const failed = (await e.host.run("lease-repo", { kind: "doctor-health" }, localAuthFixture())) as unknown as Record<
      string,
      unknown
    >;
    assert.equal(failed.failureCode, "ECONNREFUSED", JSON.stringify(failed));
    assert.deepEqual(failed.currentCut, healthy.currentCut);
    assert.equal(failed.lastSuccessAt, healthy.lastSuccessAt);
    writeFileSync(path.join(viewDir, "head-confirmation.json"), "broken-json");
    const malformed = (await e.host.run(
      "lease-repo",
      { kind: "doctor-health" },
      localAuthFixture(),
    )) as unknown as Record<string, unknown>;
    assert.equal(malformed.failureCode, "replica_health_unreadable", JSON.stringify(malformed));
    // Restore the observed confirmation so the following authority failure reaches Keycloak.
    writeFileSync(
      path.join(viewDir, "head-confirmation.json"),
      JSON.stringify({
        headRevision: (healthy.centerCut as { revision: number }).revision,
        headDigest: (healthy.centerCut as { headDigest: string }).headDigest,
        confirmedAt: Date.parse(String(healthy.lastSuccessAt)),
      }),
    );
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
