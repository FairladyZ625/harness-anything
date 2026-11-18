// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { sourceFileOf, guiCallbackCallerFiles } from "../authorization-source-proof.mjs";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";
import { replaceSourceOnce, runGit } from "./helpers.mjs";
import {
  auditDurableActionAuthorization,
  changedAuthorizationScope,
  loadAuthorizationInputs,
  shardedAudit,
} from "../ontology-durable-action-authorization.mjs";
import { exitCodeFor } from "../ontology-gate-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let ordinal = 0;
function partitionedTest(name, run) {
  if (testOrdinalInPartition(ordinal++, process.env.HARNESS_TEST_PARTITION, [1, 1, 2, 3, 4, 1, 2, 4, 2]))
    test(name, run);
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
function sourceCopy(t, { copyPackages = ["daemon"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "incremental-authorization-"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "incremental-authorization-worktree", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  mkdirSync(path.join(dir, "packages"));
  for (const entry of readdirSync(path.join(repoRoot, "packages"))) {
    const target = path.join(dir, "packages", entry);
    if (copyPackages.includes(entry)) {
      mkdirSync(target, { recursive: true });
      for (const item of readdirSync(path.join(repoRoot, "packages", entry))) {
        const srcItem = path.join(repoRoot, "packages", entry, item);
        const destItem = path.join(target, item);
        if (item === "src" || item === "scripts") cpSync(srcItem, destItem, { recursive: true });
        else if (statSync(srcItem).isDirectory()) symlinkSync(srcItem, destItem, linkType);
        else cpSync(srcItem, destItem);
      }
    } else symlinkSync(path.join(repoRoot, "packages", entry), target, linkType);
  }
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), linkType);
  symlinkSync(path.join(repoRoot, "tools"), path.join(dir, "tools"), linkType);
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "core.excludesFile", "/dev/null"]);
  return dir;
}

// Reuse the existing real AuthorizationPort negative control, now on both selection paths.
partitionedTest("incremental permission route keeps the full proof's positive and negative verdicts", async (t) => {
  const inputs = await loadAuthorizationInputs(repoRoot);
  const dir = sourceCopy(t);
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

partitionedTest(
  "sharded incremental cut for daemon/client.ts avoids false positive on unmodified multiplexed GUI routes",
  async () => {
    const only = [
      "task.start",
      "task.complete",
      "task.consent",
      "task.pin",
      "task.progress.append",
      "task.submit",
      "task.unpin",
    ];
    const result = await shardedAudit(repoRoot, ["packages/cli/src/daemon/client.ts"], { only });
    assert.deepEqual(result.findings, []);
    assert.equal(result.rows.find((row) => row.id === "task.start")?.ok, true);
    assert.equal(
      result.rows.find((row) => row.id === "task.attest"),
      undefined,
    );
    const clientSource = result.sourceRows.find((row) =>
      row.id.includes("task-actions.ts#useTaskActions.once.promise:973c6c96"),
    );
    assert.equal(clientSource?.ok, true);
    assert.match(clientSource?.evidence?.[0] ?? "", /typed GUI callback client port/u);
  },
);

partitionedTest(
  "modified multiplexed GUI client traces all forwarded routes and fails closed when mutated to call an unauthorized route",
  async (t) => {
    const dir = sourceCopy(t, {
      copyPackages: ["gui", "daemon", "authorization-keycloak", "application", "kernel"],
    });
    const file = "packages/gui/src/renderer/task-actions.ts";
    const only = [
      "task.start",
      "task.attest",
      "task.complete",
      "task.consent",
      "task.pin",
      "task.progress.append",
      "task.rework",
      "task.submit",
      "task.unpin",
    ];
    const green = await shardedAudit(repoRoot, [file], { sourceRoot: dir, only });
    assert.deepEqual(green.findings, []);
    assert.equal(green.rows.find((row) => row.id === "task.start")?.ok, true);
    assert.equal(green.rows.find((row) => row.id === "task.attest")?.ok, true);
    const target = path.join(dir, file),
      original = readFileSync(target, "utf8");
    const mutated = replaceSourceOnce(
      replaceSourceOnce(
        original,
        'import { harnessClient } from "./api-client.ts";',
        'import { harnessClient } from "./api-client.ts";\nimport { invoke } from "./api-client-invoke.ts";',
        file,
      ),
      "await harnessClient.taskAttest({",
      'await invoke("unauthorized.route" as never, {',
      file,
    );
    writeFileSync(target, mutated);
    const red = await shardedAudit(repoRoot, [file], { sourceRoot: dir, only });
    assert.ok(red.findings.length > 0);
    assert.equal(exitCodeFor("ratchet", red.findings.length), 1);
    const clientSource = red.sourceRows.find((row) =>
      row.id.includes("task-actions.ts#useTaskActions.once.promise:973c6c96"),
    );
    assert.equal(clientSource?.ok, false);
  },
);

// dec_B9B5BF3C86195DF4186D01668D/CH3: fix the source cycle, preserving every type edge.
partitionedTest("daemon leaf action changes stay below 60 descriptors and detect a restored type cycle", async () => {
  const inputs = await loadAuthorizationInputs(repoRoot);
  const started = performance.now();
  const sourceFiles = inputs.constants.actionDeclarations.flatMap((action) => [
    ...(action.ontology?.sources ?? []).map(sourceFileOf),
    ...Object.values(action.ontology?.entries ?? {}).flatMap((entry) => [
      entry.file,
      ...(entry.builder ? [entry.builder] : []),
    ]),
  ]);
  const graph = buildFlowGraph(repoRoot, {
    sourceFiles: [...new Set(sourceFiles)],
    lexicalFiles: guiCallbackCallerFiles(
      repoRoot,
      sourceFiles.filter((file) => /^packages\/gui\/src\/(?:renderer|preload|browser)\//u.test(file)),
    ),
  });
  const durableInputs = {
    ...inputs,
    descriptors: inputs.descriptors.filter((descriptor) => descriptor.commandClass !== "repo-read"),
  };
  const file = "packages/daemon/src/todo-action.ts";
  const count = () => changedAuthorizationScope(graph, durableInputs, [file]).descriptorIds?.size;
  const selected = changedAuthorizationScope(graph, durableInputs, [file]).descriptorIds;
  assert.ok(selected?.has("todo-add") && selected.has("todo.add"), "both todo write ingresses remain selected");
  const descriptors = count();
  console.log(
    `DAEMON_LEAF_SCOPE ${JSON.stringify({ descriptors, total: durableInputs.descriptors.length, seconds: (performance.now() - started) / 1000 })}`,
  );
  assert.ok(descriptors > 0 && descriptors < 60, `todo-action selected ${descriptors} descriptors; expected 1..59`);
  // Moving declarations alone is insufficient if their signatures still type-import the
  // composition root: every leaf importing the shared contracts joins the dispatcher again.
  const contracts = "packages/daemon/src/repo-cell-types.ts";
  const original = graph.modules.get(contracts);
  try {
    graph.modules.set(contracts, {
      ...original,
      sourceFile: ts.createSourceFile(
        contracts,
        `${original.sourceFile.text}\nimport type { RepoCellActionContext as RestoredContext } from "./repo-cell-action-context.ts";`,
        ts.ScriptTarget.Latest,
        true,
      ),
    });
    const restored = count();
    console.log(`DAEMON_LEAF_RESTORED_CYCLE ${JSON.stringify({ descriptors: restored })}`);
    assert.ok(restored >= 200, `restored type cycle selected only ${restored} descriptors`);
  } finally {
    graph.modules.set(contracts, original);
  }
  assert.equal(count(), descriptors);
});

// dec_B9B5BF3C86195DF4186D01668D/CH3 & dec_88CAA23DE4907261D7ECB107ED/CH1: every shard must share
// technical-port/support roots when computing changedAuthorizationScope so tooling helper edits
// never cause one shard to run scoped (0 descriptors) while sibling shards fall back to full.
partitionedTest(
  "shardedAudit keeps consistent incremental scope across shards when changed files reach only technical-port tooling sources",
  async () => {
    const result = await shardedAudit(
      repoRoot,
      ["tools/affected-tests.mjs", "tools/affected-tests.test.mjs", "tools/test-tier-manifest.mjs"],
      { shardCount: 4, concurrency: 2 },
    );
    assert.deepEqual(result.findings, []);
    assert.ok(
      result.rows.length > 0 && result.rows.length < 100,
      `expected scoped descriptor rows (1..99), got ${result.rows.length}`,
    );
    assert.ok(result.rows.every((row) => row.ok));
    assert.ok(result.sourceRows.length >= 1, "technical-port tooling importers are verified in incremental scope");
    assert.ok(result.sourceRows.every((row) => row.ok));
  },
);
