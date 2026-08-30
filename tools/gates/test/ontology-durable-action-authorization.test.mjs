// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditDurableActionAuthorization, main } from "../ontology-durable-action-authorization.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-2 reports the base advisory and names an action whose AuthorizationPort call is removed", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot])).code, 0);
  const rootDir = mkdtempSync(path.join(tmpdir(), "ontology-action-authorization-"));
  const actionFixture = path.join(rootDir, "durable-actions.json");
  writeRepoFile(rootDir, "durable-actions.json", '["durable-write"]\n');
  writeRepoFile(
    rootDir,
    "packages/daemon/src/authorization.ts",
    [
      "interface AuthorizationPort { authorize(action: unknown): unknown }",
      "const daemonAuthorizationPort: AuthorizationPort = { authorize: (action) => action };",
      "export function authorizeAction(action: unknown) { return daemonAuthorizationPort.authorize(action); }",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/receipt-domain-registry.ts",
    "interface WriteReceipt { readonly authorizationDecision: AuthorizationDecision }\n",
  );
  const handlerPath = "packages/daemon/src/action-handler.ts";
  writeRepoFile(
    rootDir,
    handlerPath,
    'function execute(action: { kind: string }) { if (action.kind === "durable-write") return authorizeAction(action); }\n',
  );
  assert.equal(auditDurableActionAuthorization(rootDir, ["durable-write"]).rows[0].authorizationPort, true);

  writeRepoFile(
    rootDir,
    handlerPath,
    'function execute(action: { kind: string }) { if (action.kind === "durable-write") return action; }\n',
  );
  const result = auditDurableActionAuthorization(rootDir, ["durable-write"]);
  assert.equal(result.rows[0].authorizationPort, false);
  assert.match(result.findings.join("\n"), /durable-write: durable execution path/u);
  const positive = captureGate(() => main(["--root", rootDir, "--fixture", actionFixture, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /durable-write \| missing/u);
});
