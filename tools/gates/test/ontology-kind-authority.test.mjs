// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditKindAuthority, main } from "../ontology-kind-authority.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("G0-1 reports the base advisory and names an injected registry-external kind", () => {
  assert.equal(captureGate(() => main(["--root", repoRoot])).code, 0);
  const rootDir = mkdtempSync(path.join(tmpdir(), "ontology-kind-authority-"));
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/entity-kind-registry.ts",
    'export const entityKindContracts = Object.freeze([{ kind: "task" }]) as const;\n',
  );
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/entity-ref.ts",
    [
      'export const entityKindRefAuthorities = Object.freeze([{ kind: "task" }, { kind: "phantom" }]) as const;',
      'export type EntityRefKind = (typeof entityKindRefAuthorities)[number]["kind"] | "relation";',
      "",
    ].join("\n"),
  );
  const result = auditKindAuthority(rootDir);
  assert.match(result.findings.join("\n"), /entity-ref\.ts:1.*phantom/u);
  const positive = captureGate(() => main(["--root", rootDir, "--mode", "ratchet"]));
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /phantom/u);
});
