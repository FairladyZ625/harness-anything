// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol-commands.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoTaskAction } from "../src/repo-cell.ts";
import { initIngressRepo } from "./fixtures/runtime-ingress.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { removeTemporaryDirectory } from "../../../tools/temporary-directory-cleanup.mjs";

const actor = { principal: { personId: "person-owner" }, executor: null },
  binding = withRoleBinding({ actor, source: "local" as const }, "repo-read"),
  actions = new Map<string, RepoTaskAction>([
    ["decision-list", { kind: "decision-list" }],
    ["decision-show", { kind: "decision-show", decisionId: "dec_MISSING" }],
    ["fact-show", { kind: "fact-show", factId: "F-MISSING" }],
    ["fact-type-list", { kind: "fact-type-list" }],
    ["relation-list", { kind: "relation-list" }],
    ["relation-triples", { kind: "relation-triples" }],
  ]);

test("every query-only declaration completes through the synchronous fixture reader", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-query-only-contract-")),
    repoId = workspaceId("query-only-contract"),
    declared = daemonProtocolCommands.filter((command) => command.repoCellExecution === "query-only");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initIngressRepo(rootDir, process.getuid?.() ?? 0);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "query-only-contract" });
    for (const command of declared) {
      const action =
        actions.get(command.id) ??
        ({ kind: "actionKind" in command ? command.actionKind : command.id } as RepoTaskAction);
      const receipt = await cell.run(action, binding);
      assert.ok(receipt && typeof receipt === "object", command.id);
    }
  } finally {
    await cell?.close();
    await removeTemporaryDirectory(rootDir);
  }
});
