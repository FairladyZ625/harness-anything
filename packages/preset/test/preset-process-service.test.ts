// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPresetProcessService, installPresetPackage } from "../src/index.ts";

test("start durably returns admitted before spawn and status exposes every daemon-owned phase", async () => {
  const fixture = scriptedPackage(`console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));`), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 1_000, publish: async () => { throw new Error("unexpected produce"); } });
  try {
    const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "once" });
    assert.equal(started.outcome, "started"); assert.equal(started.phase, "admitted"); assert.deepEqual(service.status(started.runId).phases, ["admitted"]);
    const terminal = await waitFor(() => service.status(started.runId), ({ outcome }) => outcome === "applied");
    assert.equal(terminal.outcome, "applied"); assert.deepEqual(terminal.phases, ["admitted", "spawned", "running", "publishing", "applied"]); assert.match(terminal.resultDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  } finally { await service.close(); fixture.cleanup(); }
});

test("admission rejects missing entrypoint, bad input, missing capability, and invalid user shadow within one second", async () => {
  const valid = scriptedPackage(`console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));`), missing = scriptedPackage("", { requires: [{ id: "cap:missing/v1", kind: "command", version: "1" }] });
  const service = createPresetProcessService({ rootDir: valid.rootDir, userRoot: valid.userRoot, publish: async () => { throw new Error("not spawned"); } }), missingService = createPresetProcessService({ rootDir: missing.rootDir, userRoot: missing.userRoot, publish: async () => { throw new Error("not spawned"); } });
  try {
    const started = performance.now(), entrypoint = await service.start({ presetId: "user-canary", entrypoint: "absent", inputs: { title: "Canary" }, idempotencyKey: "missing-entry" }), badInput = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: {}, idempotencyKey: "bad-input" }), capability = await missingService.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "missing-capability" });
    write(path.join(valid.userRoot, "active/user-canary.json"), JSON.stringify({ schema: "preset-active-pointer/v1", presetId: "user-canary", verticalId: "software/coding", digest: "f".repeat(64) })); const shadow = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "invalid-shadow" });
    assert.equal(performance.now() - started < 1_000, true); assert.deepEqual([entrypoint.code, badInput.code, capability.code, shadow.code], ["entrypoint_not_found", "invalid_input", "missing_provider", "shadow_invalid"]); assert.equal([entrypoint, badInput, capability, shadow].every(({ outcome, phases }) => outcome === "rejected" && phases.join() === "rejected"), true);
  } finally { await service.close(); await missingService.close(); valid.cleanup(); missing.cleanup(); }
});

test("bounded child protocol classifies every failure without a silent phase", async () => {
  const cases = [
    ["never-output", "setInterval(() => {}, 1_000);", "timeout"], ["nonzero", "process.exit(7);", "child_exit"], ["signal", 'process.kill(process.pid, "SIGTERM");', "child_signal"], ["malformed", 'console.log("{");', "malformed_result"], ["oversize", 'process.stdout.write("x".repeat(200));', "result_oversize"], ["disconnect", "(await import('node:fs')).closeSync(1); setInterval(() => {}, 1_000);", "child_disconnect"]
  ] as const;
  for (const [name, script, code] of cases) { const fixture = scriptedPackage(script), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 300, maxResultBytes: 128, publish: async () => { throw new Error("not reached"); } }); try { const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: name }); assert.equal(started.phase, "admitted"); const result = await waitFor(() => service.status(started.runId), ({ outcome }) => outcome === "failed"); assert.equal(result.code, code, JSON.stringify(result)); assert.equal(result.phases[0], "admitted"); assert.equal(result.phases.at(-1), "failed"); } finally { await service.close(); fixture.cleanup(); } }
});

test("idempotency never respawns and restart recovery stays outcome_unknown without retry", async () => {
  const fixture = scriptedPackage("setInterval(() => {}, 1_000);"), first = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 5_000, publish: async () => ({ outcome: "applied" }) }); let recovered: ReturnType<typeof createPresetProcessService> | undefined;
  try {
    const started = await first.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" }), duplicate = await first.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" }); assert.equal(duplicate.runId, started.runId);
    await waitFor(() => first.status(started.runId), ({ phase }) => phase === "running"); recovered = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 50, publish: async () => { throw new Error("must not retry"); } }); const unknown = recovered.status(started.runId), replay = await recovered.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" });
    assert.equal(unknown.outcome, "outcome_unknown"); assert.equal(replay.outcome, "outcome_unknown"); assert.equal(unknown.phases.filter((phase) => phase === "spawned").length, 1); assert.equal(unknown.phases.at(-1), "outcome_unknown");
  } finally { await recovered?.close(); await first.close(); fixture.cleanup(); }
});

test("permission staging denies authored, Git, and raw paths while declared produces use only the admitted command", async () => {
  const writer = scriptedPackage('const { target } = JSON.parse(process.env.HA_PRESET_INPUT); (await import("node:fs")).writeFileSync(target, "forbidden"); console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));', { inputs: [{ name: "target", type: "string", required: true }] });
  const targets = [path.join(writer.rootDir, "authored.txt"), path.join(writer.rootDir, ".git/config-owned"), path.join(tmpdir(), `ha-raw-${path.basename(writer.rootDir)}`)], denied = createPresetProcessService({ rootDir: writer.rootDir, userRoot: writer.userRoot, timeoutMs: 1_000, publish: async () => { throw new Error("not reached"); } });
  try { for (const [index, target] of targets.entries()) { const started = await denied.start({ presetId: "user-canary", entrypoint: "check", inputs: { target }, idempotencyKey: `denied-${index}` }), result = await waitFor(() => denied.status(started.runId), ({ outcome }) => outcome === "failed"); assert.equal(result.code, "child_exit"); assert.equal(existsSync(target), false); } } finally { await denied.close(); writer.cleanup(); }

  const producer = scriptedPackage('console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [{ capabilityId: "policy:task-create/v1", payload: { title: "Produced", taskId: "task-produced" } }] }));', { produces: [{ id: "policy:task-create/v1", kind: "command", version: "1" }] }), published: Array<Record<string, unknown>> = [], service = createPresetProcessService({ rootDir: producer.rootDir, userRoot: producer.userRoot, timeoutMs: 1_000, admitProduce: (kind) => kind === "task-create", publish: async (action) => { published.push(action); return { outcome: "applied" }; } });
  try { const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "produce" }), result = await waitFor(() => service.status(started.runId), ({ outcome }) => outcome === "applied"); assert.equal(result.outcome, "applied"); assert.deepEqual(published, [{ kind: "task-create", title: "Produced", taskId: "task-produced" }]); } finally { await service.close(); producer.cleanup(); }
});

function scriptedPackage(script: string, entrypoint: Record<string, unknown> = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-process-")), userRoot = path.join(rootDir, ".harness/presets"), source = path.join(rootDir, "source/user-canary");
  write(path.join(source, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "user-canary", title: "User Canary", vertical: "software/coding", version: "3.0.0", kind: "process-action", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], entrypoints: { check: { type: "script", intent: "Run canary", inputs: [{ name: "title", type: "string", required: true }], requires: [], produces: [], sideEffects: [], command: "scripts/check.mjs", ...entrypoint } }, profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" }));
  write(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Canary\nwhenToUse: Verify process actions.\n---\n# Canary\n"); write(path.join(source, "scripts/check.mjs"), script); installPresetPackage({ source, userRoot });
  return { rootDir, userRoot, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}
function write(target: string, body: string): void { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); }
async function waitFor<T>(read: () => T, done: (value: T) => boolean): Promise<T> { let last: T; for (let attempt = 0; attempt < 100; attempt += 1) { last = read(); if (done(last)) return last; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`terminal preset run not observed: ${JSON.stringify(last!)}`); }
