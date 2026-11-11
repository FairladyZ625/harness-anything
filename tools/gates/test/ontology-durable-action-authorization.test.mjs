// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testOrdinalInPartition } from "../../node-test-runner-lib.mjs";
import { buildFlowGraph } from "../authorization-flow-graph.mjs";
import {
  auditDurableActionAuthorization,
  kindRewriteViolations,
  loadAuthorizationInputs,
} from "../ontology-durable-action-authorization.mjs";
import { replaceSourceOnce, runGit } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tracedPackages = ["daemon", "authorization-keycloak", "application"];
const inputs = await loadAuthorizationInputs(repoRoot);

const partitionValue = process.env.HARNESS_TEST_PARTITION;
let partitionTestOrdinal = 0;
// Greedy balance from measured durations; each partition sums to 209–221s versus 350/497s with
// ordinal modulo two. New tests must update this map after measuring their duration.
const authorizationTestPartitionAssignments = [4, 2, 4, 3, 1, 2, 4, 1, 2, 2, 3, 4, 1, 3, 1, 4, 3, 2, 3, 3, 4, 1, 1];
function partitionedTest(name, testFn) {
  const ordinal = partitionTestOrdinal++;
  if (!testOrdinalInPartition(ordinal, partitionValue, authorizationTestPartitionAssignments)) return;
  test(name, testFn);
}

// Every control mutates a copy of the real sources on disk; the other packages and node_modules are
// linked read-only so imports resolve exactly as they do in the checkout.
function sourceCopy(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "durable-authorization-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "packages"));
  for (const entry of readdirSync(path.join(repoRoot, "packages"))) {
    const target = path.join(dir, "packages", entry);
    if (tracedPackages.includes(entry)) {
      cpSync(path.join(repoRoot, "packages", entry, "src"), path.join(target, "src"), { recursive: true });
      cpSync(path.join(repoRoot, "packages", entry, "package.json"), path.join(target, "package.json"));
    } else {
      symlinkSync(path.join(repoRoot, "packages", entry), target, "dir");
    }
  }
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  // The gate enumerates sources through git; the excludesFile pin keeps host ignores out.
  runGit(dir, ["init", "--quiet"]);
  runGit(dir, ["config", "core.excludesFile", "/dev/null"]);
  return dir;
}

// A checkout shaped like a task worktree: its own workspace sources plus a node_modules tree
// shared with the canonical install, which is where a linked worktree's workspace links point.
function worktreeCopy(t) {
  const dir = sourceCopy(t),
    kernel = path.join(dir, "packages", "kernel");
  unlinkSync(kernel);
  cpSync(path.join(repoRoot, "packages/kernel/src"), path.join(kernel, "src"), { recursive: true });
  cpSync(path.join(repoRoot, "packages/kernel/package.json"), path.join(kernel, "package.json"));
  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "durable-authorization-worktree", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
  );
  return dir;
}

function edit(dir, file, from, to) {
  const target = path.join(dir, file),
    text = readFileSync(target, "utf8");
  writeFileSync(target, replaceSourceOnce(text, from, to, file));
  return () => writeFileSync(target, text);
}

partitionedTest("source mutation fragments match LF and CRLF checkouts alike", () => {
  const lf = "alpha\nbeta\ngamma\n",
    crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(replaceSourceOnce(lf, "alpha\nbeta", "alpha\nX\nY", "sample.ts"), "alpha\nX\nY\ngamma\n");
  assert.equal(replaceSourceOnce(crlf, "alpha\nbeta", "alpha\nX\nY", "sample.ts"), "alpha\r\nX\r\nY\r\ngamma\r\n");
  // A fragment authored with CRLF matches an LF checkout too, and a single-line fragment adopts the file's EOL.
  assert.equal(replaceSourceOnce(lf, "alpha\r\nbeta", "alpha\nZ", "sample.ts"), "alpha\nZ\ngamma\n");
  assert.equal(replaceSourceOnce(crlf, "beta", "Z\nW", "sample.ts"), "alpha\r\nZ\r\nW\r\ngamma\r\n");
  // The exactly-once requirement is not weakened: zero and multiple matches still fail.
  assert.throws(() => replaceSourceOnce(crlf, "missing", "x", "sample.ts"), /exactly once/u);
  assert.throws(() => replaceSourceOnce("repeat\r\nrepeat\r\n", "repeat", "x", "sample.ts"), /exactly once/u);
});

function rows(dir, only, descriptors = inputs.descriptors, options = {}) {
  const result = auditDurableActionAuthorization(
    repoRoot,
    { ...inputs, descriptors },
    { sourceRoot: dir, only, ...options },
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row]));
}

/** Normal green, mutated red (for the stated reason), restored green, on the same copy. */
function threeStage(t, ids, mutate, { dir = sourceCopy(t), reason } = {}) {
  const before = rows(dir, ids);
  for (const id of ids) assert.ok(before[id].ok, `${id}: real sources must be green`);
  const restore = mutate(dir);
  const mutated = rows(dir, ids);
  for (const id of ids) {
    assert.equal(mutated[id].ok, false, `${id}: the mutation must turn the row red`);
    if (reason) assert.match(mutated[id].violations.join("; "), reason, `${id}: ${mutated[id].violations}`);
  }
  restore();
  const restored = rows(dir, ids);
  for (const id of ids) assert.ok(restored[id].ok, `${id}: restoring the source must return to green`);
  return mutated;
}

const queuedRoute = "packages/daemon/src/repo-cell-command-run.ts";

partitionedTest("removing the queued RepoCell authorization call turns its durable commands red", (t) => {
  threeStage(t, ["task-create", "todo-add"], (dir) =>
    edit(dir, queuedRoute, "queuedDecision = await authorizeAtCurrentCut()!;", "queuedDecision = undefined!;"),
  );
});

partitionedTest("a denial branch that no longer exits is a bypass, not an authorization", (t) => {
  threeStage(t, ["task-create"], (dir) =>
    edit(
      dir,
      queuedRoute,
      'if (queuedDecision.outcome === "denied")\n              return withAuthorizationDecision(',
      'if (queuedDecision.outcome === "denied")\n              void withAuthorizationDecision(',
    ),
  );
});

partitionedTest("extracting the authorization helper under different names stays green", (t) => {
  const dir = sourceCopy(t);
  const file = path.join(dir, queuedRoute),
    text = readFileSync(file, "utf8");
  assert.ok(text.includes("return evaluateRepoCellAction({"));
  writeFileSync(
    file,
    text
      .replaceAll("authorizeAtCurrentCut", "policyVerdictAtHead")
      .replace("return evaluateRepoCellAction({", "return readPolicyVerdict({") +
      "\nfunction readPolicyVerdict(input: Parameters<typeof evaluateRepoCellAction>[0]): Promise<AuthorizationDecision> {\n" +
      "  const verdict = evaluateRepoCellAction(input);\n  return verdict;\n}\n",
  );
  const traced = rows(dir, ["task-create", "todo-add"]);
  assert.ok(traced["task-create"].ok, traced["task-create"].evidence.join("; "));
  assert.ok(traced["todo-add"].ok, traced["todo-add"].evidence.join("; "));
});

partitionedTest("a declared local-transport route is red once its transport exit is removed", (t) => {
  const stop = threeStage(t, ["daemon-stop"], (dir) =>
    edit(
      dir,
      "packages/daemon/src/protocol/json-rpc-dispatch-support.ts",
      'if (authContext.transportKind !== "unix-socket" || authContext.nodePrincipal)',
      "if (authContext.nodePrincipal)",
    ),
  );
  assert.deepEqual(stop["daemon-stop"].evidence, []);
  threeStage(t, ["daemon-fleet-edge-sync"], (dir) =>
    edit(
      dir,
      "packages/daemon/src/daemon-host-runtime-api.ts",
      "        context.localOnly(auth);\n        const persistedConfig = readFleetEdgeConfig(request.workspaceRoot),",
      "        const persistedConfig = readFleetEdgeConfig(request.workspaceRoot),",
    ),
  );
  threeStage(t, ["repo-bootstrap"], (dir) =>
    edit(
      dir,
      "packages/daemon/src/daemon-host-repository-api.ts",
      "      context.localOnly(auth);\n      const requestedRoot",
      "      const requestedRoot",
    ),
  );
});

partitionedTest("a local-process command must send the daemon only a read", (t) => {
  const dir = sourceCopy(t);
  const start = inputs.descriptors.find((descriptor) => descriptor.id === "daemon-start");
  assert.equal(start.hostAuthority, "local-process");
  assert.ok(rows(dir, ["daemon-start"])["daemon-start"].ok);
  const writing = inputs.descriptors.map((descriptor) =>
    descriptor === start ? { ...descriptor, method: "daemon.stop" } : descriptor,
  );
  assert.equal(rows(dir, ["daemon-start"], writing)["daemon-start"].ok, false);
});

const accessAdmin = "packages/daemon/src/access-admin-service.ts";

partitionedTest("an own-session route is red once the account it changes no longer comes from the session", (t) => {
  // The person named by the request, not the signed-in person, would receive the new password.
  const changed = threeStage(t, ["access-password-change"], (dir) =>
    edit(
      dir,
      accessAdmin,
      "return this.#writePasswordCredential(request, actor, false);",
      'return this.#writePasswordCredential(request, text(request.personId, "personId"), false);',
    ),
  );
  assert.deepEqual(changed["access-password-change"].evidence, []);
  // The session requirement replaced by request data: the identity is whatever the caller claims.
  threeStage(t, ["access-password-change"], (dir) =>
    edit(
      dir,
      accessAdmin,
      "? this.#oidc.requireSession(request.rootDir)",
      '? Promise.resolve({ personId: text(request.personId, "personId"), accessToken: "" })',
    ),
  );
});

partitionedTest("an own-session route through a differently named session helper stays green", (t) => {
  const dir = sourceCopy(t);
  const file = path.join(dir, accessAdmin),
    text = readFileSync(file, "utf8");
  assert.equal(text.split("? this.#oidc.requireSession(request.rootDir)").length, 2);
  writeFileSync(
    file,
    text
      .replace("? this.#oidc.requireSession(request.rootDir)", "? this.#signedInAccount(request.rootDir)")
      .replace(
        "  close(): Promise<void> {",
        "  #signedInAccount(target?: string) {\n    return this.#oidc.requireSession(target);\n  }\n\n  close(): Promise<void> {",
      ),
  );
  const traced = rows(dir, ["access-password-change"])["access-password-change"];
  assert.ok(traced.ok, traced.violations.join("; "));
});

partitionedTest("an AuthorizationPort decision for another action does not authorize this one", (t) => {
  // The permission-request route evaluates its own policy action; folding the request onto
  // another action's spelling must not borrow that decision.
  threeStage(t, ["permission-request-decide"], (dir) =>
    edit(
      dir,
      "packages/daemon/src/access-admin-service.ts",
      'action: "permission-request-decide",',
      'action: "permission-request-create",',
    ),
  );
});

const rewriteRows = ["agent-run", "runtime-batch", "edge-join"];

partitionedTest("a kind-rewrite route is traced against the kind it actually authorizes", (t) => {
  // dec_2BF45FF7E52020380F5F35CE2D/CH6: agent-run and runtime-batch are authorized as runtime-run.
  // Removing that decision's denial exit turns both red even though the declaration still stands.
  const today = { today: "2026-11-07" };
  const dir = sourceCopy(t);
  for (const id of rewriteRows) assert.ok(rows(dir, rewriteRows, undefined, today)[id].ok, `${id}: green`);
  const restore = edit(
    dir,
    "packages/daemon/src/repo-cell-authorization.ts",
    'if (authorizationDecision.outcome === "denied")\n    throw cellCodedError(\n      "authorization_denied",\n      authorizationDecision.nextActions.join(" ") || `${input.action.kind} requires repository write authority.`,',
    'if (authorizationDecision.outcome === "denied")\n    void cellCodedError(\n      "authorization_denied",\n      authorizationDecision.nextActions.join(" ") || `${input.action.kind} requires repository write authority.`,',
  );
  const mutated = rows(dir, ["agent-run", "runtime-batch"], undefined, today);
  assert.equal(mutated["agent-run"].ok, false);
  assert.equal(mutated["runtime-batch"].ok, false);
  restore();
  const restored = rows(dir, rewriteRows, undefined, today);
  for (const id of rewriteRows) assert.ok(restored[id].ok, `${id}: restored green`);
});

partitionedTest("a kind-rewrite declaration turns red after its expiry date", () => {
  const before = rows(repoRoot, rewriteRows, undefined, { today: "2026-12-07" }),
    after = rows(repoRoot, rewriteRows, undefined, { today: "2026-12-08" });
  for (const id of rewriteRows) {
    assert.ok(before[id].ok, `${id}: green through its expiry day`);
    assert.equal(after[id].ok, false, `${id}: red the day after expiry`);
    assert.match(after[id].violations.join("; "), /kindRewrite expired on 2026-12-07/);
  }
});

partitionedTest("a kind-rewrite declaration must cite an indexed decision and owner task", () => {
  const valid = inputs.descriptors.find((descriptor) => descriptor.id === "agent-run").kindRewrite;
  assert.deepEqual(kindRewriteViolations(valid, "2026-11-07"), []);
  assert.match(
    kindRewriteViolations({ ...valid, sourceDecision: "dec_00000000000000000000000000/CH1" }, "2026-11-07").join(),
    /source decision .* is not in the evidence index/,
  );
  assert.match(
    kindRewriteViolations({ ...valid, ownerTask: "task_00000000000000000000000000" }, "2026-11-07").join(),
    /owner task .* is not in the evidence index/,
  );
  assert.match(kindRewriteViolations({ ...valid, expires: "soon" }, "2026-11-07").join(), /not a YYYY-MM-DD date/);
});

// Each link of the queued route is its own failure class: the effect must run after the denial
// exit, receive the decision, and the decision must be evaluated at the current canonical cut.
partitionedTest("an effect callback that runs before the authorization denial exit is red", (t) => {
  threeStage(
    t,
    ["task-create"],
    (dir) => {
      const first = edit(
          dir,
          queuedRoute,
          "if (durable) {\n            queuedDecision = await authorizeAtCurrentCut()!;",
          "const alreadyExecuted = await execute(queuedDecision);\n          if (durable) {\n            queuedDecision = await authorizeAtCurrentCut()!;",
        ),
        second = edit(
          dir,
          queuedRoute,
          "context.withHumanSummary(await execute(queuedDecision))",
          "context.withHumanSummary(alreadyExecuted)",
        );
      return () => {
        second();
        first();
      };
    },
    { reason: /effect callback runs before the authorization denial exit/ },
  );
});

partitionedTest("an effect callback called without the authorization decision is red", (t) => {
  threeStage(t, ["task-create"], (dir) => edit(dir, queuedRoute, "await execute(queuedDecision)", "await execute()"), {
    reason: /effect callback runs without the authorization decision/,
  });
});

partitionedTest("a canonical decision evaluated at a fixed revision instead of the current cut is red", (t) => {
  threeStage(
    t,
    ["task-create", "task-push"],
    (dir) =>
      edit(
        dir,
        queuedRoute,
        "const revision = context.store.readHead()?.revision ?? 0,\n          actionId",
        "const revision = 0,\n          actionId",
      ),
    { reason: /decision is evaluated at the fixed cut "canonical:0"/ },
  );
});

partitionedTest("a durable action that skips the queued authorization is red", (t) => {
  threeStage(
    t,
    ["task-create"],
    (dir) => edit(dir, queuedRoute, "(durableActionKinds as readonly string[]).includes(action.kind)", "false"),
    { reason: /effect callback runs before the authorization denial exit/ },
  );
});

partitionedTest("a prepared publication must run the real handler and hand it the decision", (t) => {
  const dir = sourceCopy(t);
  threeStage(
    t,
    ["task-push"],
    (copy) =>
      edit(
        copy,
        queuedRoute,
        "readBeforeWriteQueue(context, action, binding)",
        "unrelatedPreparation(context, action, binding)",
      ),
    { dir, reason: /the authorized effect does not resolve/ },
  );
  threeStage(
    t,
    ["task-push"],
    (copy) =>
      edit(
        copy,
        queuedRoute,
        "publish(action, authorizationDecision ? { ...binding, authorizationDecision } : binding)",
        "publish(action, binding)",
      ),
    { dir, reason: /the authorization decision does not reach the effect/ },
  );
});

partitionedTest("a same-named prepared handler in an unrelated file does not stand in for the real one", (t) => {
  const dir = sourceCopy(t);
  threeStage(
    t,
    ["task-push"],
    (copy) => {
      const restore = edit(
          copy,
          "packages/daemon/src/write-queue-external-reads.ts",
          "export function readBeforeWriteQueue(",
          "export function disconnectedPreparation(",
        ),
        unrelated = path.join(copy, "packages/daemon/src/unrelated-preparation.ts");
      writeFileSync(unrelated, "export function readBeforeWriteQueue() {\n  return null;\n}\n");
      return () => {
        rmSync(unrelated);
        restore();
      };
    },
    { dir },
  );
});

partitionedTest("an equivalent prepared publication written as a function expression stays green", (t) => {
  const dir = sourceCopy(t);
  edit(
    dir,
    "packages/daemon/src/write-queue-external-reads.ts",
    "return async (_action: RepoTaskAction, executionBinding: RepoCellBinding) => {",
    "return async function (_action: RepoTaskAction, executionBinding: RepoCellBinding) {",
  );
  const traced = rows(dir, ["task-push"])["task-push"];
  assert.ok(traced.ok, traced.violations.join("; "));
});

partitionedTest("edge-join is red once its daemon-repo-register denial no longer exits", (t) => {
  threeStage(t, ["edge-join"], (dir) =>
    edit(
      dir,
      "packages/daemon/src/host-action-authorization.ts",
      'if (decision.outcome === "denied")\n    throw Object.assign(',
      'if (decision.outcome === "denied")\n    void Object.assign(',
    ),
  );
});

// Dominance is per path: an enforcer on one branch of a test must not lend its evidence to the
// branch that skips it and reaches the same effect.
partitionedTest("an authorization on only one branch of a test does not authorize the branch that skips it", (t) => {
  threeStage(
    t,
    ["runtime-instance-create"],
    (dir) =>
      edit(
        dir,
        "packages/daemon/src/daemon-host-runtime-api.ts",
        "const authorizationDecision = await requireAuthorizedFleetAction({\n        kind: actionKind,",
        "let authorizationDecision: AuthorizationDecision | undefined;\n      if (payload.probe !== true)\n        authorizationDecision = await requireAuthorizedFleetAction({\n        kind: actionKind,",
      ),
    { reason: /reaches the code after it without the runtime-instance-create authorization/ },
  );
  threeStage(
    t,
    ["task-create"],
    (dir) =>
      edit(
        dir,
        queuedRoute,
        "if (durable) {\n            queuedDecision = await authorizeAtCurrentCut()!;",
        'if (durable && binding.source !== "local") {\n            queuedDecision = await authorizeAtCurrentCut()!;',
      ),
    { reason: /without the task-create authorization|effect callback runs before the authorization denial exit/ },
  );
});

partitionedTest("a branch skips authorization only when the authorization port itself chose it", (t) => {
  // D1: access configuration stays open until the port reports that someone holds access-manage.
  // The same skip chosen by request data instead of the port is a bypass.
  threeStage(
    t,
    ["node-unregister"],
    (dir) =>
      edit(
        dir,
        "packages/authorization-keycloak/src/oidc-session-service.ts",
        "!(await this.#bootstrapRequired(await this.#centerToken()))",
        "loginTarget !== undefined",
      ),
    { reason: /reaches the code after it without the access-manage authorization/ },
  );
});

partitionedTest("a worktree root anchors on its own kernel sources instead of the shared install", (t) => {
  const dir = worktreeCopy(t),
    file = "packages/kernel/src/ports/authorization-port.ts",
    members = buildFlowGraph(dir).interfaceMembers(file, "AuthorizationPort");

  // The anchor resolves (the pre-fix lookup reported the interface missing) and it is the local
  // copy: a program that followed the shared node_modules links would hand back the canonical file.
  assert.ok(members.has("authorize"));
  assert.equal(realpathSync(members.get("authorize").getSourceFile().fileName), realpathSync(path.join(dir, file)));
});

test("S1a source routes resolve to their own action authorization descriptor", () => {
  const bound = inputs.descriptors.filter((row) => row.ontologySources?.length);
  assert.ok(bound.length > 0);
  const declaredSources = new Map(
    inputs.constants.actionDeclarations.flatMap((action) =>
      (action.ontology?.sources ?? []).map((source) => [source.candidateId, action.kind]),
    ),
  );
  for (const descriptor of bound) {
    for (const source of descriptor.ontologySources)
      assert.equal(declaredSources.get(source), descriptor.actionKind ?? descriptor.id);
  }
});

test("a source cannot borrow another action's authorization route", async (t) => {
  const { writeRepoFile } = await import("./helpers.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "source-route-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeRepoFile(
    root,
    "packages/kernel/src/index.ts",
    `export const actionDeclarations = [{kind:'task-delete', executionClass:'repo-write', ontology:{sources:[{candidateId:'action:foreign',route:'task-start'}]}}];`,
  );
  writeRepoFile(
    root,
    "packages/daemon/src/protocol/daemon-protocol.contract.ts",
    `export const daemonProtocolCommands = [{id:'task-start',method:'repo.task.run',commandClass:'repo-write'}]; export const daemonGuiActionMethods = [];`,
  );
  writeRepoFile(
    root,
    "packages/daemon/src/protocol/daemon-protocol-commands.ts",
    `export const daemonProtocolMethods = [];`,
  );
  await assert.rejects(loadAuthorizationInputs(root), /does not resolve to its owning authorization descriptor/u);
});
