// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { parseVerticalScriptAction, parseVerticalScriptPlan, parseVerticalScriptResult } from "../../src/index.ts";
import { validateVerticalScriptAction, validateVerticalScriptPlan, validateVerticalScriptResult } from "../../src/domain/vertical-script-action.ts";

const action = { schema: "vertical-script-action/v1", kind: "script-run", scriptId: "vertical:software-coding:adr-seed", taskId: null, inputs: { locale: "en-US" }, dryRun: true } as const;
const plan = { schema: "vertical-script-plan/v1", scriptId: action.scriptId, ok: true, status: "planned", report: { rows: 1 }, warnings: [], changes: [{ path: "decisions/adrs/0000-template.md", body: "# ADR\n", mediaType: "text/markdown", disposition: "create" }] } as const;
const result = { schema: "vertical-script-result/v1", scriptId: action.scriptId, mode: "dry-run", ok: true, status: "planned", report: plan.report, warnings: [], documents: [{ path: plan.changes[0].path, sha256: `sha256:${"a".repeat(64)}`, size: 6, mediaType: "text/markdown", disposition: "create" }], planDigest: `sha256:${"b".repeat(64)}` } as const;

test("vertical script action and plan validators are closed and parse canonical values", () => {
  assert.deepEqual(validateVerticalScriptAction(action), []);
  assert.deepEqual(parseVerticalScriptAction(action), action);
  assert.deepEqual(validateVerticalScriptPlan(plan), []);
  assert.deepEqual(parseVerticalScriptPlan(plan), plan);
  assert.deepEqual(validateVerticalScriptResult(result), []);
  assert.deepEqual(parseVerticalScriptResult(result), result);
  for (const invalid of [
    { ...action, unknown: true },
    { ...action, scriptId: undefined },
    { ...action, inputs: { locale: 1 } }
  ]) assert.notEqual(validateVerticalScriptAction(invalid).length, 0);
  for (const invalid of [
    { ...plan, unknown: true },
    { ...plan, changes: plan.changes.map(({ body: _body, ...change }) => change) },
    { ...plan, changes: [{ ...plan.changes[0], disposition: "overwrite" }] }
  ]) assert.notEqual(validateVerticalScriptPlan(invalid).length, 0);
  for (const invalid of [{ ...result, unknown: true }, { ...result, status: undefined }, { ...result, documents: [{ ...result.documents[0], size: "6" }] }]) assert.notEqual(validateVerticalScriptResult(invalid).length, 0);
});
