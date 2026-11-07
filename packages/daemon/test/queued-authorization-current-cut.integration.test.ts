// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { policyTestRealm, withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./task-surface.fixtures.ts";

// A durable write's decision answers for the canonical cut its effect lands on. A request admitted
// while another write is still pending must be decided at the head that write leaves, not at the
// head it saw when it was submitted: a cut read once and reused would authorize a stale state.
test("a queued write is authorized at the cut its effect lands on, after an earlier write advances the head", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-queued-current-cut-")),
    repoId = workspaceId("queued-current-cut"),
    realm = policyTestRealm;
  initRepo(rootDir);
  const cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "queued-current-cut" });
  t.after(async () => {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  // The policy realm answers every decision over HTTP; the first task-create decision is held at
  // that authority until the second write has been admitted behind it.
  let entered!: () => void, release!: () => void;
  const firstEntered = new Promise<void>((resolve) => (entered = resolve)),
    firstReleased = new Promise<void>((resolve) => (release = resolve)),
    answer = realm.keycloak.fetch;
  let decisions = 0;
  const seen: string[] = [];
  realm.keycloak.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const evaluation = String(url).endsWith("/authz/resource-server/policy/evaluate");
    seen.push(String(url));
    if (evaluation && ++decisions === 1) {
      entered();
      await firstReleased;
    }
    return answer(url, init);
  }) as typeof fetch;
  t.after(() => {
    realm.keycloak.fetch = answer;
  });

  const binding: RepoCellBinding = withPolicyGroup({ actor, source: "local" as const }, "contributor");

  const first = cell.run({ kind: "task-create", title: "first queued write" }, binding);
  // The first write must reach its queued authorization; if it settles first, report how.
  const reached = await Promise.race([firstEntered.then(() => null), first.then((receipt) => ({ settled: receipt }))]);
  assert.equal(
    reached,
    null,
    `the first write settled before its queued authorization: ${seen.join(" | ")} ${JSON.stringify(reached)}`,
  );
  const second = cell.run({ kind: "task-create", title: "second queued write" }, binding);
  release();
  const [firstReceipt, secondReceipt] = (await Promise.all([first, second])) as unknown as {
    outcome: string;
    revision: number;
    authorizationDecision: { outcome: string; evaluatedAtCut: string };
  }[];

  assert.equal(firstReceipt.outcome, "applied", JSON.stringify(firstReceipt));
  assert.equal(secondReceipt.outcome, "applied", JSON.stringify(secondReceipt));
  assert.ok(decisions >= 2, "each queued write asks the policy authority in its own turn");
  // The first write is decided at the head before it and lands one revision later.
  assert.equal(firstReceipt.authorizationDecision.evaluatedAtCut, `canonical:${firstReceipt.revision - 1}`);
  // The second was admitted before the first landed; it is decided at the head the first left.
  assert.ok(secondReceipt.revision > firstReceipt.revision);
  assert.equal(secondReceipt.authorizationDecision.evaluatedAtCut, `canonical:${firstReceipt.revision}`);
  assert.equal(secondReceipt.authorizationDecision.evaluatedAtCut, `canonical:${secondReceipt.revision - 1}`);
});
