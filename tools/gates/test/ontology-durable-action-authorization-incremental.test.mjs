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
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import ts from "typescript";
import {
  AUTHORIZATION_CI_SHARD_COUNT,
  authorizationCiRun,
  readAuthorizationShards,
  serializeAuthorizationShard,
} from "../authorization-ci-shards.mjs";
import {
  authorizationShardBuckets,
  finishSourceRows,
  partitionAuthorizationSources,
} from "../authorization-audit-shards.mjs";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { readAuthorizationTypes } from "../authorization-shared-types.mjs";
import { sourceFileOf, guiCallbackCallerFiles } from "../authorization-source-proof.mjs";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";
import { replaceSourceOnce, runGit } from "./helpers.mjs";
import {
  auditAuthorizationPart,
  auditDurableActionAuthorization,
  authorizationAuditConcurrencyLimit,
  changedAuthorizationScope,
  collectAuthorizationAudit,
  loadAuthorizationInputs,
  shardedAudit,
  shardWorkerCount,
} from "../ontology-durable-action-authorization.mjs";
import { exitCodeFor } from "../ontology-gate-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
let ordinal = 0;
function partitionedTest(name, run) {
  // Keep the two full worker-startup tests in different Colab partitions.
  if (testOrdinalInPartition(ordinal++, process.env.HARNESS_TEST_PARTITION, [1, 1, 2, 3, 1, 4, 1, 2, 4, 3]))
    test(name, run);
}

test("authorization admission is bounded by the runner CPU and memory budgets", () => {
  const gib = 1024 ** 3;
  assert.equal(shardWorkerCount(4, 15.625 * gib), 2);
  assert.equal(shardWorkerCount(2, 24 * gib), 2);
  assert.equal(shardWorkerCount(8, 24 * gib), 4);
  assert.equal(shardWorkerCount(4, 4 * gib), 1);
  assert.equal(shardWorkerCount(8, 24 * gib, 1), 1);
  assert.equal(authorizationAuditConcurrencyLimit({ HARNESS_AUTH_AUDIT_CONCURRENCY: "2" }), 2);
  assert.equal(authorizationAuditConcurrencyLimit({}), null);
  assert.throws(
    () => authorizationAuditConcurrencyLimit({ HARNESS_AUTH_AUDIT_CONCURRENCY: "0" }),
    /HARNESS_AUTH_AUDIT_CONCURRENCY must be a positive integer/u,
  );
});

test("a late checker notification cannot consume the next request's unpublished reply", (t) => {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const checker = readAuthorizationTypes({ meta: { modules: [] }, port: port1, signal });
  let wakes = 0;
  t.mock.method(Atomics, "wait", () => {
    if (++wakes === 2) {
      assert.equal(receiveMessageOnPort(port2).message.method, "typeName");
      port2.postMessage({ value: "ReplyType" });
      Atomics.store(signal, 0, 1);
    }
    return "ok";
  });
  try {
    assert.equal(checker.queries.typeName("input"), "ReplyType");
    assert.equal(wakes, 2);
  } finally {
    checker.release();
    port2.close();
  }
});

test("descriptor sources and shared native entry routes each have exactly one shard", () => {
  const bindings = (route, role, ...ids) => ids.map((candidateId) => ({ route, role, candidateId }));
  const actions = [
    { kind: "daemon-start", ontology: { sources: bindings("daemon:bin", "effect", "start-1", "start-2") } },
    { kind: "migrate-storage", ontology: { sources: bindings("daemon:bin", "effect", "migrate-1", "migrate-2") } },
    {
      kind: "script-run",
      ontology: {
        sources: [
          ...bindings("script-run", "script", "script-1", "script-2"),
          ...bindings("script-run", "client", "client"),
        ],
      },
    },
    { kind: "cli", ontology: { sources: bindings("cli:ha", "effect", "native-cli") } },
  ];
  const durable = [{ id: "script-run" }];
  const partition = () =>
    Array.from({ length: 4 }, (_, index) =>
      partitionAuthorizationSources(actions, authorizationShardBuckets(actions, durable), { index, count: 4 }),
    );
  const shards = partition().map((shard) => shard.flatMap((action) => action.ontology.sources));
  assert.deepEqual(partition(), partition());
  assert.deepEqual(
    shards
      .flat()
      .map((source) => source.candidateId)
      .sort(),
    actions.flatMap((action) => action.ontology.sources.map((source) => source.candidateId)).sort(),
  );
  const owners = (route) =>
    shards.flatMap((sources, index) => (sources.some((source) => source.route === route) ? [index] : []));
  assert.deepEqual(owners("script-run"), [0]);
  assert.equal(owners("daemon:bin").length, 1);
  assert.equal(owners("cli:ha").length, 1);
});

test("CI rejects missing, duplicated, incomplete and incompatible authorization proofs", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "authorization-shards-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stamp = {
    revision: "fixture-revision",
    today: "2026-11-20",
    scope: "fixture-scope",
    count: AUTHORIZATION_CI_SHARD_COUNT,
  };
  const row = { id: "client-entry", kind: "task-start", route: "task.start" };
  const inventory = { routes: [[7, "task.start"]], sources: [[0, row.id, row.kind, row.route]] };
  const run = { dir, stamp };
  const writePart = (index, proof, inputs = stamp) =>
    writeFileSync(
      path.join(dir, `authorization-shard-${index}.json`),
      serializeAuthorizationShard({ stamp: inputs, partition: { index } }, proof),
      { flag: "wx" },
    );
  const result = { rows: [{ index: 7, id: "task.start" }], sourceProofs: [{ ordinal: 0, row }] };
  const empty = { rows: [], sourceProofs: [] };
  const replace = (index, proof, inputs = stamp) => {
    rmSync(path.join(dir, `authorization-shard-${index}.json`));
    writePart(index, proof, inputs);
  };
  for (let index = 1; index < stamp.count; index++) writePart(index, empty);
  assert.throws(() => readAuthorizationShards(run, inventory), /every shard exactly once/u);
  writePart(0, result);
  assert.deepEqual(readAuthorizationShards(run, inventory), result);
  replace(1, result);
  assert.throws(() => readAuthorizationShards(run, inventory), /coverage differs for routes/u);
  replace(1, empty, { ...stamp, revision: "stale-revision" });
  assert.throws(() => readAuthorizationShards(run, inventory), /incompatible audit inputs/u);
  replace(1, empty);
  replace(0, { ...result, sourceProofs: [] });
  assert.throws(() => readAuthorizationShards(run, inventory), /coverage differs for sources/u);
  assert.throws(
    () => authorizationCiRun(repoRoot, undefined, { AUTHORIZATION_CI_MODE: "blocked" }),
    /a required quick-gate job failed/u,
  );
});

test("a multiplexed client loses authority when its other shard rejects a server route", () => {
  const row = {
    id: "client",
    kind: "task-start",
    route: "task.start",
    clientRoutes: ["task.attest", "task.start"],
    isRead: false,
  };
  const proofs = [{ row, rawClient: ["typed client"], authority: "authorization-port", witnessed: true, within: true }];
  const accepted = { id: "task.start", kind: "task-start", ok: true };
  const other = { id: "task.attest", kind: "task-attest", ok: false };
  const durable = [
    [accepted.id, accepted.kind],
    [other.id, other.kind],
  ];
  assert.deepEqual(finishSourceRows(proofs, [accepted, other], durable), [
    {
      ...row,
      authority: "authorization-port",
      ok: false,
      evidence: [],
      violations: ["client source route task.attest targets an unverified server authorization descriptor"],
    },
  ]);
  assert.equal(finishSourceRows(proofs, [accepted, { ...other, ok: true }], durable)[0].ok, true);
});

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
      "packages/kernel/src/domain/action-source-facets/daemon.json",
      "packages/kernel/src/domain/source-contract-facets/daemon.json",
      "packages/daemon/src/daemon-host/protocol/daemon-protocol.contract.ts",
      ...["open", "api", "command", "action-context", "action-dispatch", "command-run"].map(
        (name) => `packages/daemon/src/daemon-host/repo-cell-${name}.ts`,
      ),
      "packages/daemon/src/daemon-host/daemon-host-open.ts",
      "packages/daemon/src/daemon-host/rpc-command-routing.ts",
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
  const file = "packages/daemon/src/daemon-host/access-admin-service.ts";
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
    ["tools/gates/ontology-durable-action-authorization.mjs", "--mode", "ratchet", "--changed-files-stdin"],
    { cwd: repoRoot, encoding: "utf8", input: JSON.stringify(changedFiles), maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const count = /unproven authorization routes: 0\/(\d+)/u.exec(result.stdout);
  assert.ok(count, result.stdout);
  return { seconds: (performance.now() - started) / 1000, descriptors: Number(count[1]), stdout: result.stdout };
}

partitionedTest("stdin authorization scope rejects malformed or non-path input before auditing", () => {
  // dec_04A9211B073F29F0FC1E1CA573 CH3: transport changes retain fail-closed input parsing.
  for (const input of ["not-json", "{}", '["valid.ts", 1]']) {
    const result = spawnSync(
      process.execPath,
      ["tools/gates/ontology-durable-action-authorization.mjs", "--changed-files-stdin"],
      { cwd: repoRoot, encoding: "utf8", input },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /JSON|array of paths/u);
  }
});

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
  "CI shards preserve the serial verdict when a multiplexed GUI client is mutated to call an unauthorized route",
  async (t) => {
    const dir = sourceCopy(t, {
      copyPackages: ["gui", "daemon", "authorization", "application", "kernel"],
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
    const inputs = await loadAuthorizationInputs(repoRoot);
    const today = new Date().toISOString().slice(0, 10);
    const options = { sourceRoot: dir, only, today };
    const changedFiles = [file];
    const serial = () => auditDurableActionAuthorization(repoRoot, inputs, { ...options, changedFiles });
    const parallel = async () => {
      const proofs = mkdtempSync(path.join(tmpdir(), "authorization-shards-"));
      t.after(() => rmSync(proofs, { recursive: true, force: true }));
      const stamp = { today, count: 2 };
      const rowsPerPartition = [];
      for (let index = 0; index < stamp.count; index++) {
        const partition = { index, count: stamp.count };
        const part = await auditAuthorizationPart(repoRoot, inputs, changedFiles, {
          ...options,
          partition,
          concurrency: 1,
        });
        rowsPerPartition.push(part.rows.length);
        writeFileSync(
          path.join(proofs, `authorization-shard-${index}.json`),
          serializeAuthorizationShard({ stamp, partition }, part),
        );
      }
      const result = collectAuthorizationAudit(repoRoot, inputs, { dir: proofs, stamp }, { ...options, changedFiles });
      return { result, rowsPerPartition };
    };
    const { result: green, rowsPerPartition } = await parallel();
    assert.ok(
      rowsPerPartition.every((count) => count > 0),
      "the valid client scope crosses both partitions",
    );
    assert.deepEqual(green, serial());
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
    const { result: red } = await parallel();
    assert.deepEqual(red, serial());
    assert.ok(red.findings.length > 0);
    assert.equal(exitCodeFor("ratchet", red.findings.length), 1);
    const clientSource = red.sourceRows.find((row) =>
      row.id.includes("task-actions.ts#useTaskActions.once.promise:973c6c96"),
    );
    assert.equal(clientSource?.ok, false);
    assert.ok(red.findings.some((finding) => finding.startsWith(`${clientSource.id}: `)));
    console.log(
      `AUTHORIZATION_NEGATIVE_CONTROL ${JSON.stringify({ candidateId: clientSource.id, findings: red.findings })}`,
    );
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
  const file = "packages/daemon/src/daemon-host/todo-action.ts";
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
  const contracts = "packages/daemon/src/daemon-host/repo-cell-types.ts";
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
      [
        "tools/affected-tests.mjs",
        "tools/affected-tests.test.mjs",
        "tools/test-tier-manifest.mjs",
        "tools/stress/core/controller.mjs",
      ],
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
    assert.ok(
      result.sourceRows.some(
        (row) =>
          row.authority === "technical-port" &&
          row.evidence.some((line) =>
            line.includes("tools/stress/core/controller.mjs#runScenario.options.adapter.submit"),
          ),
      ),
      "workers resolve the adapter method declared inside the stress controller's JSDoc",
    );
  },
);
