// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import { loadGateAllowlist } from "../../gate-allowlists/load-gate-allowlist.mjs";
import { auditOntologyClosure } from "../ontology-closure-audit.mjs";
import { scanOntologyText } from "../ontology-closure-scan.mjs";
import { evaluateOntologyClosure } from "../ontology-closure.mjs";
import { loadOntologyClosureSnapshot } from "../ontology-gate-lib.mjs";
import { loadAuthorizationInputs, shardWorkerCount } from "../ontology-durable-action-authorization.mjs";
import {
  clientEntryEvidence,
  clientEntryRequiredRoutes,
  guiCallbackCallerFiles,
  sourceWitnesses,
  technicalPortEvidence,
} from "../authorization-source-proof.mjs";
import { makeRepo, replaceSourceOnce } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const main = "packages/gui/src/main/";
const bridge = "packages/gui/src/api/service-bridge.ts";
const files = [
  bridge,
  ...[
    "electron-main",
    "ipc-handlers",
    "local-main-controls",
    "local-composition-root",
    "desktop-first-run",
    "update-service",
  ].map((f) => `${main}${f}.ts`),
];
const inputs = await loadAuthorizationInputs(repoRoot);
const local = inputs.constants.actionDeclarations.find((a) => a.kind === "daemon-local-state");
const submit = inputs.constants.actionDeclarations.find((a) => a.kind === "task-submit");
const bootstrap = inputs.constants.actionDeclarations.find((a) => a.kind === "repo-bootstrap");
const nativeSources = local.ontology.sources.filter(
  (s) =>
    s.role === "technical-port" &&
    (s.candidateId.includes("src/main/update-service.ts#") ||
      s.candidateId.includes("src/main/desktop-first-run.ts#serviceInstallFailure.")),
);
const sources = [
  ["ipc-handlers.ts#registerHarnessIpcHandlers:", submit, `${bridge}#GuiServiceBridge.invoke`],
  ["local-main-controls.ts#addLocalMainControls.invoke.result:", submit, `${bridge}#GuiServiceBridge.invoke`],
  ["local-composition-root.ts#request:38ae", submit, `${main}local-composition-root.ts#request.invoke`],
  [
    "local-composition-root.ts#bootstrapLocalRepository:",
    bootstrap,
    `${main}local-composition-root.ts#bootstrapLocalRepository.invoke`,
  ],
].map(([fragment, action, port]) => {
  const source = inputs.constants.actionDeclarations
    .flatMap((a) => a.ontology?.sources ?? [])
    .find((s) => s.candidateId?.includes(fragment));
  assert.ok(source, fragment);
  return {
    action,
    source: { ...source, port, role: "client", route: action === submit ? "task.submit" : action.kind },
  };
});

function graphFor(mutation) {
  const texts = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(repoRoot, f), "utf8")]));
  if (mutation) texts[mutation[0]] = replaceSourceOnce(texts[mutation[0]], mutation[1], mutation[2]);
  const { rootDir } = makeRepo(texts);
  symlinkSync(realpathSync(path.join(repoRoot, "node_modules")), path.join(rootDir, "node_modules"), "dir");
  // Scoped/sharded audits must recover the composition caller even when its support source
  // belongs to another shard. Do not give the proof its composition files by hand.
  const sourceFiles = files.filter((file) => file !== `${main}electron-main.ts` && file !== bridge);
  const lexicalFiles = guiCallbackCallerFiles(rootDir, sourceFiles);
  assert.ok(lexicalFiles.includes(`${main}electron-main.ts`));
  assert.ok(lexicalFiles.includes(bridge));
  return buildFlowGraph(rootDir, { anchorRoot: repoRoot, sourceFiles, lexicalFiles });
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: forwarding proves every business route, never a local technical port.
test("live GUI main forwarding binds business clients and requires every multiplexed server authorization route", () => {
  const graph = graphFor();
  const witnesses = sourceWitnesses(
    graph,
    sources.map(({ source }) => source),
  );
  for (const { action, source } of sources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    assert.ok(clientEntryEvidence(graph, node, source, action, inputs.descriptors), source.candidateId);
    const required = clientEntryRequiredRoutes(graph, node, source, action, inputs.descriptors);
    assert.ok(required.includes(source.route), source.candidateId);
    if (action === submit) {
      assert.ok(required.length > 10, "multiplexing must require all business routes");
      for (const route of ["runtime-handoff-export", "runtime-handoff-claim", "runtime-handoff-revoke"]) {
        assert.ok(required.includes(route), route);
        assert.equal(
          clientEntryEvidence(
            graph,
            node,
            source,
            action,
            inputs.descriptors.filter((d) => d.id !== route),
          ),
          null,
          route,
        );
      }
    }
    assert.equal(
      technicalPortEvidence(
        graph,
        node,
        { ...source, role: "technical-port", route: local.kind },
        local,
        inputs.descriptors,
      ),
      null,
    );
    assert.equal(
      clientEntryEvidence(
        graph,
        node,
        { ...source, route: source.route === "repo-bootstrap" ? "task.submit" : "repo-bootstrap" },
        action,
        inputs.descriptors,
      ),
      null,
    );
    assert.equal(
      clientEntryEvidence(
        graph,
        node,
        source,
        action,
        inputs.descriptors.filter((d) => d.id !== source.route),
      ),
      null,
    );
  }
});

test("main native setup and updater ports retain local authority without borrowing business routes", () => {
  const graph = graphFor();
  const witnesses = sourceWitnesses(graph, nativeSources);
  assert.ok(nativeSources.length >= 7);
  for (const source of nativeSources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    assert.ok(technicalPortEvidence(graph, node, source, local, inputs.descriptors), source.candidateId);
  }
});

test("native main callbacks cannot hide a typed daemon bridge under local authority", () => {
  const graph = graphFor([
    `${main}update-service.ts`,
    "    current = status;",
    `    current = status;
    const remote = null as unknown as import("../api/service-bridge.ts").GuiServiceBridge;
    void remote.invoke("submitTask", {});`,
  ]);
  const sources = nativeSources.filter((s) => s.candidateId.includes("update-service.ts#"));
  const witnesses = sourceWitnesses(graph, sources);
  for (const source of sources) {
    const node = witnesses.get(source.candidateId);
    assert.ok(node, source.candidateId);
    assert.equal(technicalPortEvidence(graph, node, source, local, inputs.descriptors), null, source.candidateId);
  }
});

for (const [name, mutation] of [
  [
    "unknown-method guard removed",
    [bridge, 'if (!route) return failure("method_not_allowed", `Unsupported GUI service method: ${method}`);', ""],
  ],
  [
    "forwarded route replaced",
    [`${main}local-composition-root.ts`, "          route.rpcMethod,", '          "repo.task.submit",'],
  ],
  [
    "bootstrap route replaced",
    [`${main}local-composition-root.ts`, '        "daemon.repo.bootstrap",', '        "repo.task.submit",'],
  ],
  [
    "composition injects unproven bridge",
    [`${main}electron-main.ts`, "      bridge,", "      bridge: unprovenBridge,"],
  ],
]) {
  test(`GUI main forwarding fails closed when ${name}`, () => {
    const graph = graphFor(mutation);
    const pairs = name.startsWith("bootstrap") ? sources.slice(3) : sources.slice(0, 3);
    const witnesses = sourceWitnesses(
      graph,
      pairs.map(({ source }) => source),
    );
    for (const { action, source } of pairs) {
      const node = witnesses.get(source.candidateId);
      assert.ok(node, source.candidateId);
      assert.equal(clientEntryEvidence(graph, node, source, action, inputs.descriptors), null, source.candidateId);
      assert.equal(
        technicalPortEvidence(
          graph,
          node,
          { ...source, role: "technical-port", route: local.kind },
          local,
          inputs.descriptors,
        ),
        null,
        source.candidateId,
      );
    }
  });
}

// dec_7E44897ECDCAEF2B92EC66A260/CH1: packages/gui (all categories) and repo baseline are zeroed and locked.
test("dec_7E44897ECDCAEF2B92EC66A260/CH1: packages/gui full-package closure is zeroed and locked", () => {
  const empty = { actions: [], kinds: [] };
  const audit = (candidates, options = {}) =>
    auditOntologyClosure({ candidates, baseline: [], previous: [], snapshot: empty, ...options });
  const debt = (candidate) => ({
    id: candidate.id,
    category: candidate.category,
    owner: "gui",
    status: "legacy-to-remove",
    replacementRef: "action:daemon-local-state",
    removalSlice: "Onto-H",
    ref: "dec_7E44897ECDCAEF2B92EC66A260",
    reason: candidate.reason,
  });
  const assertRegistered = (rows, message) =>
    assert.deepEqual(
      rows.filter((row) => row.status !== "registered"),
      [],
      message,
    );
  assert.deepEqual(
    loadGateAllowlist("ontology-closure", { report: false }).candidates,
    [],
    "repo ontology-closure debt must be 0",
  );
  const guiAll = evaluateOntologyClosure({ rootDir: repoRoot, base: "HEAD" }).classified.filter((r) =>
    r.file.startsWith("packages/gui/"),
  );
  for (const cat of ["action", "judgment", "policy"]) {
    const rows = guiAll.filter((r) => r.category === cat);
    assert.ok(rows.length > 0, `packages/gui/${cat} must remain covered`);
    assertRegistered(rows, `packages/gui/${cat}`);
  }
  const mainActions = guiAll.filter((r) => r.category === "action" && r.file.startsWith("packages/gui/src/main/"));
  assert.ok(mainActions.length > 0, "GUI main actions must have registered coverage without freezing a count floor");
  assertRegistered(mainActions, "main actions must have no unregistered or legacy debt");
  assert.deepEqual(
    guiAll.filter((r) => r.category === "action" && r.declarationRef === "action:cli-local-effects"),
    [],
  );
  const decl = (frag) => mainActions.find((r) => r.id.includes(frag))?.declarationRef;
  assert.equal(decl("oidc-auth-ipc.ts#requireSuccessfulAuthReply:"), "action:rbac-bootstrap");
  assert.equal(decl("artifact-open-ipc.ts#openMaterializedCopy:"), "action:daemon-local-state");
  const snapshot = loadOntologyClosureSnapshot(repoRoot);
  for (const [file, snippet, sym] of [
    ["artifact-open-ipc.ts", "function undeclaredMainFs() { writeFileSync('/tmp/x', 'y'); }", "undeclaredMainFs"],
    ["ipc-handlers.ts", "function undeclaredMainIpc() { ipcMain.handle('h:m', () => {}); }", "undeclaredMainIpc"],
    ["oidc-auth-ipc.ts", "function undeclaredMainAuth() { dispatch(); }", "undeclaredMainAuth"],
  ]) {
    const target = `packages/gui/src/main/${file}`;
    const source = readFileSync(path.join(repoRoot, target), "utf8");
    const scanned = scanOntologyText(target, source);
    assert.deepEqual(audit(scanned, { snapshot }).findings, [], target);
    const removed = scanned.find((r) => r.category === "action");
    assert.ok(removed, target);
    const prunedSnapshot = {
      ...snapshot,
      actions: snapshot.actions.map((entry) =>
        entry.ontology
          ? {
              ...entry,
              ontology: {
                ...entry.ontology,
                sources: entry.ontology.sources.filter((s) => s.candidateId !== removed.id),
              },
            }
          : entry,
      ),
    };
    assert.deepEqual(
      audit(
        scanned.filter((r) => r.id !== removed.id),
        { snapshot: prunedSnapshot },
      ).findings,
      [],
      `${target}: legitimate removal of a registered main action must pass`,
    );
    const mutated = scanOntologyText(target, `${source}\n${snippet}\n`);
    const red = audit(mutated, { snapshot });
    assert.deepEqual(
      red.findings.map((f) => [f.code, f.symbol]),
      [["ONTOLOGY_ACTION_UNDECLARED", sym]],
      target,
    );
    const added = mutated.find((row) => row.id === red.findings[0].id);
    const growth = audit(mutated, { snapshot, baseline: [debt(added)], previous: [] }).findings;
    assert.equal(growth[0].code, "ONTOLOGY_BASELINE_GROWTH");
    const action = {
      kind: "daemon-local-state",
      ontology: { owner: "gui", sources: [{ candidateId: added.id, route: "daemon-local-state" }] },
    };
    assert.deepEqual(
      audit(mutated, { snapshot: { ...snapshot, actions: [...snapshot.actions, action] } }).findings,
      [],
      "newly registered main action must pass",
    );
  }
});

test("dec_88CAA23DE4907261D7ECB107ED/CH1: shardedAudit worker count stays within 16 GiB runner RAM budget", () => {
  const gib = 1024 ** 3;
  assert.equal(shardWorkerCount(4, Math.floor(15.62 * gib)), 2);
  assert.equal(shardWorkerCount(4, 16 * gib), 2);
  assert.equal(shardWorkerCount(4, 5 * gib), 1);
  assert.equal(shardWorkerCount(8, 22 * gib), 3);
  assert.equal(shardWorkerCount(8, 32 * gib), 4);
});
