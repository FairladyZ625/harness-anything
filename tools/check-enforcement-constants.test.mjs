// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkEnforcementConstants } from "./check-enforcement-constants.mjs";

test("accepts consumers that resolve the workflow-owned constant through the manifest", () => {
  const root = makeFixture("resolveEnforcementConstant(manifest, \"ci-integration-shard-sequence\", readAuthority);\n");
  try {
    const audit = checkEnforcementConstants(root);
    assert.equal(audit.ok, true, audit.findings.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("positive control rejects a shard count hard-coded back into a runner", () => {
  const root = makeFixture([
    "resolveEnforcementConstant(manifest, \"ci-integration-shard-sequence\", readAuthority);",
    "const integrationShardCount = 6;",
    ""
  ].join("\n"));
  try {
    const audit = checkEnforcementConstants(root);
    assert.equal(audit.ok, false);
    assert.match(audit.findings.join("\n"), /bare derived count 6/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("positive control rejects the complete shard sequence hard-coded into a runner", () => {
  const root = makeFixture([
    "resolveEnforcementConstant(manifest, \"ci-integration-shard-sequence\", readAuthority);",
    "const integrationShards = [1, 2, 3, 4, 5, 6];",
    ""
  ].join("\n"));
  try {
    const audit = checkEnforcementConstants(root);
    assert.equal(audit.ok, false);
    assert.match(audit.findings.join("\n"), /bare derived sequence \[1, 2, 3, 4, 5, 6\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a declared consumer that does not reference the manifest declaration", () => {
  const root = makeFixture("export const shards = makeShards();\n");
  try {
    const audit = checkEnforcementConstants(root);
    assert.equal(audit.ok, false);
    assert.match(audit.findings.join("\n"), /does not resolve this declaration from gate-manifest/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(consumerSource) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-enforcement-constants-"));
  mkdirSync(path.join(root, "tools"), { recursive: true });
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  const manifest = {
    enforcementConstants: [
      {
        id: "ci-integration-shard-sequence",
        description: "Integration shard ids are owned by the pull-request workflow matrix.",
        valueType: "positive-integer-sequence",
        authority: {
          kind: "workflow-matrix",
          path: ".github/workflows/rewrite-ci.yml",
          job: "integration-shard",
          matrixKey: "shard"
        },
        consumers: ["tools/run-ci-equivalent.mjs"],
        literalAudit: "forbid-derived-count-and-sequence"
      }
    ]
  };
  const workflow = [
    "jobs:",
    "  integration-shard:",
    "    strategy:",
    "      matrix:",
    "        shard: [1, 2, 3, 4, 5, 6]",
    ""
  ].join("\n");
  writeFileSync(path.join(root, "tools/gate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), workflow);
  writeFileSync(path.join(root, "tools/run-ci-equivalent.mjs"), consumerSource);
  return root;
}
