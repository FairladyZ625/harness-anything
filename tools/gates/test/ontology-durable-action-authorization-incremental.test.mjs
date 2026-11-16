// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";
import {
  auditDurableActionAuthorization,
  changedAuthorizationScope,
  loadAuthorizationInputs,
} from "../ontology-durable-action-authorization.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let ordinal = 0;
function partitionedTest(name, run) {
  if (testOrdinalInPartition(ordinal++, process.env.HARNESS_TEST_PARTITION, [1, 1, 2, 3, 4])) test(name, run);
}

function fixtureGraph(modules) {
  return {
    modules: new Map(
      Object.entries(modules).map(([file, text]) => [
        file,
        {
          sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
        },
      ]),
    ),
    importTarget: ({ file, from }) => ({ file: path.posix.normalize(path.posix.join(path.posix.dirname(file), from)) }),
  };
}
const source = (file, route) => ({ candidateId: `action:packages/daemon:${file}#handler:fixture`, route });
const action = (kind, file) => ({ kind, ontology: { sources: [source(file, kind)] } });
const fixtureInputs = {
  descriptors: ["alpha", "beta"].map((id) => ({ id, commandClass: "repo-write" })),
  constants: { actionDeclarations: [action("alpha", "routes/alpha.ts"), action("beta", "routes/beta.ts")] },
};
const fixtureModules = {
  "routes/alpha.ts": 'export { handler } from "./barrel.ts";',
  "routes/barrel.ts": 'export * from "./helper.ts";',
  "routes/helper.ts":
    'import type { Request } from "./types.ts"; type Other = import("./type-query.ts").Other; export const handler = () => {};',
  "routes/types.ts": "export interface Request {}",
  "routes/type-query.ts": "export interface Other {}",
  "routes/beta.ts": 'const load = () => import("./beta-helper.ts");',
  "routes/beta-helper.ts": "export const value = 1;",
};

partitionedTest(
  "incremental selection follows reverse import, re-export, type and dynamic edges without unrelated routes",
  () => {
    const graph = fixtureGraph(fixtureModules);
    for (const file of ["routes/helper.ts", "routes/types.ts", "routes/type-query.ts"])
      assert.deepEqual([...changedAuthorizationScope(graph, fixtureInputs, [file]).descriptorIds], ["alpha"]);
    assert.deepEqual(
      [...changedAuthorizationScope(graph, fixtureInputs, ["routes/beta-helper.ts"]).descriptorIds],
      ["beta"],
    );
    assert.deepEqual(
      [...changedAuthorizationScope(graph, fixtureInputs, ["routes\\helper.ts"]).descriptorIds],
      ["alpha"],
    );
    const cycle = fixtureGraph({ ...fixtureModules, "routes/types.ts": 'export * from "./helper.ts";' });
    assert.deepEqual(
      [...changedAuthorizationScope(cycle, fixtureInputs, ["routes/types.ts"]).descriptorIds],
      ["alpha"],
    );
  },
);

partitionedTest(
  "shared contracts, routing, graph infrastructure and unknown production inputs force the full descriptor set",
  () => {
    for (const file of [
      "packages/kernel/src/ports/authorization-port.ts",
      "packages/kernel/src/domain/action-source-facets.json",
      "packages/daemon/src/protocol/daemon-protocol.contract.ts",
      ...["open", "api", "command", "action-context", "action-dispatch", "command-run"].map(
        (name) => `packages/daemon/src/repo-cell-${name}.ts`,
      ),
      "packages/daemon/src/daemon-host-open.ts",
      "packages/daemon/src/rpc-command-routing.ts",
      "tools/gates/authorization-flow-graph.mjs",
      "tools/gate-manifest.json",
      "package-lock.json",
      "routes/deleted.ts",
      "../outside.ts",
      "routes/manifest.json",
    ]) {
      const graph = fixtureGraph({ ...fixtureModules, ...(file === "routes/deleted.ts" ? {} : { [file]: "" }) });
      const inputs = {
        ...fixtureInputs,
        constants: {
          actionDeclarations: [action("alpha", file), action("beta", "routes/beta.ts")],
        },
      };
      assert.equal(changedAuthorizationScope(graph, inputs, [file]).descriptorIds, null, file);
    }
    assert.equal(changedAuthorizationScope(fixtureGraph(fixtureModules), fixtureInputs).descriptorIds, null);
    assert.deepEqual([...changedAuthorizationScope(fixtureGraph(fixtureModules), fixtureInputs, []).descriptorIds], []);
    assert.deepEqual(
      [
        ...changedAuthorizationScope(fixtureGraph(fixtureModules), fixtureInputs, ["docs-release/guide.md"])
          .descriptorIds,
      ],
      [],
    );
  },
);

partitionedTest(
  "unowned descriptors and independent source authority checks cannot disappear from an affected cut",
  () => {
    const inputs = {
      descriptors: [...fixtureInputs.descriptors, { id: "unowned", commandClass: "repo-write" }],
      constants: {
        actionDeclarations: [...fixtureInputs.constants.actionDeclarations, action("native", "routes/helper.ts")],
      },
    };
    const scope = changedAuthorizationScope(fixtureGraph(fixtureModules), inputs, ["routes/helper.ts"]);
    assert.deepEqual([...scope.descriptorIds], ["alpha", "unowned"]);
    assert.ok(scope.sourceIds.has(source("routes/helper.ts", "native").candidateId));
  },
);

// The entire public source tree is a fresh copy for the changed host module; workspace links
// remain read-only, as in the existing mutation suite. No shared dependency entry is rewritten.
function sourceCopy(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "incremental-authorization-"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "packages"));
  for (const entry of readdirSync(path.join(repoRoot, "packages"))) {
    const target = path.join(dir, "packages", entry);
    if (entry === "daemon") {
      cpSync(path.join(repoRoot, "packages/daemon/src"), path.join(target, "src"), { recursive: true });
      cpSync(path.join(repoRoot, "packages/daemon/package.json"), path.join(target, "package.json"));
      cpSync(path.join(repoRoot, "packages/daemon/scripts"), path.join(target, "scripts"), { recursive: true });
    } else symlinkSync(path.join(repoRoot, "packages", entry), target, linkType);
  }
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), linkType);
  symlinkSync(path.join(repoRoot, "tools"), path.join(dir, "tools"), linkType);
  return dir;
}

// Reuse the existing real AuthorizationPort negative control, now on both selection paths.
partitionedTest("incremental permission route keeps the full proof's positive and negative verdicts", async (t) => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { runGit, replaceSourceOnce } = await import("./helpers.mjs");
  const inputs = await loadAuthorizationInputs(repoRoot);
  const dir = sourceCopy(t);
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "core.excludesFile", "/dev/null"]);
  const file = "packages/daemon/src/access-admin-service.ts";
  const only = ["permission-request-decide"];
  const audit = (changedFiles) =>
    auditDurableActionAuthorization(repoRoot, inputs, { sourceRoot: dir, only, changedFiles });
  const green = audit([file]);
  assert.equal(green.rows.length, 1);
  assert.ok(green.rows[0].ok);
  assert.deepEqual(green, audit());
  const target = path.join(dir, file),
    original = readFileSync(target, "utf8");
  writeFileSync(
    target,
    replaceSourceOnce(original, 'action: "permission-request-decide",', 'action: "permission-request-create",', file),
  );
  const red = audit([file]);
  assert.equal(red.rows[0].ok, false);
  assert.ok(red.findings.length > 0);
  assert.deepEqual(red, audit());
  const { exitCodeFor } = await import("../ontology-gate-lib.mjs");
  assert.equal(exitCodeFor("ratchet", red.findings.length), 1);
  writeFileSync(target, original);
  assert.ok(audit([file]).rows[0].ok);
});

function measuredGate(changedFiles) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [
      "tools/gates/ontology-durable-action-authorization.mjs",
      "--mode",
      "ratchet",
      "--changed-files-base64",
      Buffer.from(JSON.stringify(changedFiles)).toString("base64"),
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const count = /unproven authorization routes: 0\/(\d+)/u.exec(result.stdout);
  assert.ok(count, result.stdout);
  return { seconds: (performance.now() - started) / 1000, descriptors: Number(count[1]), stdout: result.stdout };
}

partitionedTest("narrow test helper cut measures the CLI path without tracing unrelated descriptors", () => {
  const { stdout, ...measurement } = measuredGate(["tools/run-local-gates-check.test.mjs"]);
  console.log(`INCREMENTAL_AUTHORIZATION_BENCHMARK ${JSON.stringify(measurement)}`);
  assert.equal(measurement.descriptors, 0);
  assert.match(stdout, /source authority: 0\/0/u);
});
