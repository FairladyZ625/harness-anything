// harness-test-tier: contract
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entityFieldContracts } from "../packages/kernel/src/domain/entity-field-contracts.ts";
import { checkEntityFieldCoverage, loadExpectedFieldLists } from "./check-schema-field-coverage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "tools/check-schema-field-coverage.mjs");

test("committed external expected list accepts the repository field contracts", () => {
  assert.deepEqual(checkEntityFieldCoverage(entityFieldContracts, loadExpectedFieldLists()), []);
});

test("schema field coverage fails closed when the contract table drops a field", () => {
  const { title: _missingTitle, ...decisionWithoutTitle } = entityFieldContracts.decision;
  const violations = checkEntityFieldCoverage(
    { ...entityFieldContracts, decision: decisionWithoutTitle },
    loadExpectedFieldLists(),
  );
  assert.match(violations.join("\n"), /decision: missing field contracts: title/u);
});

test("schema field coverage fails closed when the contract table adds an unknown field", () => {
  const violations = checkEntityFieldCoverage(
    {
      ...entityFieldContracts,
      decision: {
        ...entityFieldContracts.decision,
        bogus: {
          mutability: "immutable",
          read: [{ kind: "show", path: "decision.bogus" }],
          write: [],
          reason: "not a real field",
        },
      },
    },
    loadExpectedFieldLists(),
  );
  assert.match(violations.join("\n"), /decision: unknown field contracts: bogus/u);
});

test("schema field coverage fails closed when the external list drifts from the table", () => {
  const drifted = { ...loadExpectedFieldLists(), decision: [...loadExpectedFieldLists().decision, "ghost"].sort() };
  const violations = checkEntityFieldCoverage(entityFieldContracts, drifted);
  assert.match(violations.join("\n"), /decision: missing field contracts: ghost/u);
});

test("schema field coverage fails closed when the table grows an entity kind the list does not cover", () => {
  const violations = checkEntityFieldCoverage(
    {
      ...entityFieldContracts,
      extraKind: { someField: { mutability: "immutable", read: [], write: [], reason: "x" } },
    },
    loadExpectedFieldLists(),
  );
  assert.match(violations.join("\n"), /extraKind: field contracts exist without an external expected field list/u);
});

test("schema field coverage fails closed when an amendable field has no amend surface", () => {
  const violations = checkEntityFieldCoverage(
    {
      ...entityFieldContracts,
      decision: {
        ...entityFieldContracts.decision,
        claims: {
          ...entityFieldContracts.decision.claims,
          write: [],
        },
      },
    },
    loadExpectedFieldLists(),
  );
  assert.match(violations.join("\n"), /decision\.claims: amendable field must declare an amend write surface/u);
});

test("checkEntityFieldCoverage rejects calls without an external expected list", () => {
  assert.throws(() => checkEntityFieldCoverage(entityFieldContracts), /expectedFields must be an object/u);
});

test("gate script fails closed when the external expected list is unreadable or malformed", () => {
  const allowlistDir = mkdtempSync(path.join(tmpdir(), "ha-schema-coverage-"));
  writeFileSync(path.join(allowlistDir, "check-schema-field-coverage.json"), "{ not json", "utf8");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HARNESS_GATE_ALLOWLIST_DIR: allowlistDir },
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Gate allowlist load failed for check-schema-field-coverage/u);
});

// Positive control for the script path itself: the committed allowlist and the
// live contract table agree end to end.
test("gate script passes against the committed allowlist", () => {
  const output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: "utf8" });
  assert.match(output, /Schema field coverage check passed/u);
});
