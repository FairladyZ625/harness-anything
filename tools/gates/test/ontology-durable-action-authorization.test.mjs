// harness-test-tier: contract
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditDurableActionAuthorization,
  kindRewriteViolations,
  loadAuthorizationInputs,
} from "../ontology-durable-action-authorization.mjs";
import { runGit } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const tracedPackages = ["daemon", "authorization-keycloak", "application"];
const inputs = await loadAuthorizationInputs(repoRoot);

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

function edit(dir, file, from, to) {
  const target = path.join(dir, file),
    text = readFileSync(target, "utf8");
  assert.equal(text.split(from).length, 2, `${file}: the mutated text must occur exactly once`);
  writeFileSync(target, text.replace(from, to));
  return () => writeFileSync(target, text);
}

function rows(dir, only, descriptors = inputs.descriptors, options = {}) {
  const result = auditDurableActionAuthorization(
    repoRoot,
    { ...inputs, descriptors },
    { sourceRoot: dir, only, ...options },
  );
  return Object.fromEntries(result.rows.map((row) => [row.id, row]));
}

/** Normal green, mutated red, restored green, on the same copy. */
function threeStage(t, ids, mutate) {
  const dir = sourceCopy(t);
  for (const id of ids) assert.ok(rows(dir, ids)[id].ok, `${id}: real sources must be green`);
  const restore = mutate(dir);
  const mutated = rows(dir, ids);
  for (const id of ids) assert.equal(mutated[id].ok, false, `${id}: the mutation must turn the row red`);
  restore();
  for (const id of ids) assert.ok(rows(dir, ids)[id].ok, `${id}: restoring the source must return to green`);
  return mutated;
}

const queuedRoute = "packages/daemon/src/repo-cell-command-run.ts";

test("removing the queued RepoCell authorization call turns its durable commands red", (t) => {
  threeStage(t, ["task-create", "todo-add"], (dir) =>
    edit(dir, queuedRoute, "queuedDecision = await authorizeAtCurrentCut()!;", "queuedDecision = undefined!;"),
  );
});

test("a denial branch that no longer exits is a bypass, not an authorization", (t) => {
  threeStage(t, ["task-create"], (dir) =>
    edit(
      dir,
      queuedRoute,
      'if (queuedDecision.outcome === "denied")\n            return withAuthorizationDecision(',
      'if (queuedDecision.outcome === "denied")\n            void withAuthorizationDecision(',
    ),
  );
});

test("extracting the authorization helper under different names stays green", (t) => {
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

test("a declared local-transport route is red once its transport exit is removed", (t) => {
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
      "may sync.\n        context.localOnly(auth);",
      "may sync.",
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

test("a local-process command must send the daemon only a read", (t) => {
  const dir = sourceCopy(t);
  const start = inputs.descriptors.find((descriptor) => descriptor.id === "daemon-start");
  assert.equal(start.hostAuthority, "local-process");
  assert.ok(rows(dir, ["daemon-start"])["daemon-start"].ok);
  const writing = inputs.descriptors.map((descriptor) =>
    descriptor === start ? { ...descriptor, method: "daemon.stop" } : descriptor,
  );
  assert.equal(rows(dir, ["daemon-start"], writing)["daemon-start"].ok, false);
});

test("an AuthorizationPort decision for another action does not authorize this one", (t) => {
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

test("a kind-rewrite route is traced against the kind it actually authorizes", (t) => {
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

test("a kind-rewrite declaration turns red after its expiry date", () => {
  const before = rows(repoRoot, rewriteRows, undefined, { today: "2026-12-07" }),
    after = rows(repoRoot, rewriteRows, undefined, { today: "2026-12-08" });
  for (const id of rewriteRows) {
    assert.ok(before[id].ok, `${id}: green through its expiry day`);
    assert.equal(after[id].ok, false, `${id}: red the day after expiry`);
    assert.match(after[id].violations.join("; "), /kindRewrite expired on 2026-12-07/);
  }
});

test("a kind-rewrite declaration must cite an indexed decision and owner task", () => {
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
