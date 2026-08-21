// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPresetProcessService, installPresetPackage } from "../src/index.ts";

test("start durably returns admitted before spawn and status exposes every daemon-owned phase", async () => {
  const fixture = scriptedPackage(`console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));`), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 1_000, publish: async () => { throw new Error("unexpected produce"); } });
  try {
    const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "once" });
    assert.equal(started.outcome, "started"); assert.equal(started.phase, "admitted"); assert.deepEqual(service.status(started.runId).phases, ["admitted"]);
    const terminal = await waitFor("preset run to reach applied", () => service.status(started.runId), ({ outcome }) => outcome === "applied");
    assert.equal(terminal.outcome, "applied"); assert.deepEqual(terminal.phases, ["admitted", "spawned", "running", "publishing", "applied"]); assert.match(terminal.resultDigest ?? "", /^sha256:[0-9a-f]{64}$/u);
  } finally { await service.close(); fixture.cleanup(); }
});

test("an inherited entrypoint stages its declaring package and detects post-admission changes", async () => {
  const fixture = inheritedScriptPackage(), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 1_000, publish: async () => { throw new Error("unexpected produce"); } });
  try {
    const started = await service.start({ presetId: "leaf-canary", entrypoint: "check", inputs: { title: "Inherited" }, idempotencyKey: "inherit-ok" }); assert.equal(started.phase, "admitted"); const applied = await waitFor("inherited preset run to reach a terminal outcome", () => service.status(started.runId), ({ outcome }) => outcome === "applied" || outcome === "failed");
    assert.equal(applied.outcome, "applied", JSON.stringify(applied)); assert.deepEqual(applied.phases, ["admitted", "spawned", "running", "publishing", "applied"]);
    const admitted = await service.start({ presetId: "leaf-canary", entrypoint: "check", inputs: { title: "Tamper" }, idempotencyKey: "inherit-tamper" }); assert.equal(admitted.phase, "admitted"); write(path.join(fixture.parentObject, "scripts/check.mjs"), "process.exit(0);"); const failed = await waitFor("changed preset package rejection", () => service.status(admitted.runId), ({ outcome }) => outcome === "failed"); assert.equal(failed.code, "package_changed"); assert.deepEqual(failed.phases, ["admitted", "failed"]);
  } finally { await service.close(); fixture.cleanup(); }
});

test("admission rejects missing entrypoint, bad input, missing capability, and invalid user shadow within one second", async () => {
  const valid = scriptedPackage(`console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));`), missing = scriptedPackage("", { requires: [{ id: "cap:missing/v1", kind: "command", version: "1" }] });
  const service = createPresetProcessService({ rootDir: valid.rootDir, userRoot: valid.userRoot, publish: async () => { throw new Error("not spawned"); } }), missingService = createPresetProcessService({ rootDir: missing.rootDir, userRoot: missing.userRoot, publish: async () => { throw new Error("not spawned"); } });
  try {
    const started = performance.now(), entrypoint = await service.start({ presetId: "user-canary", entrypoint: "absent", inputs: { title: "Canary" }, idempotencyKey: "missing-entry" }), badInput = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: {}, idempotencyKey: "bad-input" }), capability = await missingService.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "missing-capability" });
    write(path.join(valid.userRoot, "active/user-canary.json"), JSON.stringify({ schema: "preset-active-pointer/v1", presetId: "user-canary", verticalId: "software/coding", digest: "f".repeat(64) })); const shadow = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "invalid-shadow" });
    assert.equal(performance.now() - started < 1_000, true); assert.deepEqual([entrypoint.code, badInput.code, capability.code, shadow.code], ["entrypoint_not_found", "invalid_input", "missing_provider", "shadow_invalid"]); assert.equal([entrypoint, badInput, capability, shadow].every(({ outcome, phases }) => outcome === "op_rejected" && phases.join() === "op_rejected"), true);
  } finally { await service.close(); await missingService.close(); valid.cleanup(); missing.cleanup(); }
});

test("bounded child protocol classifies every failure without a silent phase", async () => {
  // Node/libuv implements Windows SIGTERM with TerminateProcess(handle, 1), so a
  // self-termination has no JS signal handler and arrives as exit code 1/null signal.
  const cases = [
    ["never-output", "setInterval(() => {}, 1_000);", "timeout"], ["nonzero", "process.exit(7);", "child_exit"], ["signal", 'process.kill(process.pid, "SIGTERM");', process.platform === "win32" ? "child_exit" : "child_signal"], ["malformed", 'console.log("{");', "malformed_result"], ["oversize", 'process.stdout.write("x".repeat(200));', "result_oversize"], ["disconnect", "process.stdout.end(); setInterval(() => {}, 1_000);", "child_disconnect"]
  ] as const;
  for (const [name, script, code] of cases) { const fixture = scriptedPackage(script), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 300, maxResultBytes: 128, publish: async () => { throw new Error("not reached"); } }); try { const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: name }); assert.equal(started.phase, "admitted"); const result = await waitFor(`${name} child protocol failure`, () => service.status(started.runId), ({ outcome }) => outcome === "failed"); assert.equal(result.code, code, JSON.stringify(result)); assert.equal(result.phases[0], "admitted"); assert.equal(result.phases.at(-1), "failed"); } finally { await service.close(); fixture.cleanup(); } }
});

test("timeout forcibly reaps a child that ignores SIGTERM before publishing terminal receipt", async () => {
  // Loaded measurements did not reproduce the CI failure, so these remain explicit wall-clock
  // premises: the child must write its pid before 2s, then the timeout and SIGTERM handler must
  // become observable within waitFor's 5s polling budget. Keep both margins coupled when changing them.
  const fixture = scriptedPackage('const { writeFileSync } = await import("node:fs"); process.on("SIGTERM", () => writeFileSync("term.seen", "yes")); writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1_000);'), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 2_000, publish: async () => { throw new Error("not reached"); } }); let pid: number | undefined;
  try {
    const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "ignore-term-timeout" }), staging = path.join(fixture.rootDir, ".harness/preset-runs/staging", started.runId), pidPath = path.join(staging, "child.pid"), termPath = path.join(staging, "term.seen"); await waitFor("child.pid file for timeout fixture", () => existsSync(pidPath), Boolean); pid = Number(readFileSync(pidPath, "utf8")); if (process.platform !== "win32") await waitFor("term.seen file after timeout SIGTERM", () => existsSync(termPath), Boolean); // On Windows kill(SIGTERM) terminates unconditionally, so the handler phase cannot be witnessed; the reaped end state is asserted instead.
    assert.doesNotThrow(() => process.kill(pid!, 0)); assert.equal(terminalOutcome(service.status(started.runId).outcome), false); const terminal = await waitFor("timeout terminal receipt", () => service.status(started.runId), ({ outcome }) => outcome === "failed"); assert.equal(terminal.code, "timeout"); assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally { if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } await service.close(); fixture.cleanup(); }
});

test("close forcibly reaps a child that ignores SIGTERM within a fixed bound", async () => {
  const fixture = scriptedPackage('const { writeFileSync } = await import("node:fs"); process.on("SIGTERM", () => writeFileSync("term.seen", "yes")); writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1_000);'), service = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 5_000, publish: async () => { throw new Error("not reached"); } }); let pid: number | undefined;
  try {
    const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "ignore-term-close" }), staging = path.join(fixture.rootDir, ".harness/preset-runs/staging", started.runId), pidPath = path.join(staging, "child.pid"), termPath = path.join(staging, "term.seen"); await waitFor("child.pid file for close fixture", () => existsSync(pidPath), Boolean); pid = Number(readFileSync(pidPath, "utf8")); const before = performance.now(), closing = service.close();
    if (process.platform === "win32") assert.equal(terminalOutcome(service.status(started.runId).outcome), false); // Windows terminates unconditionally once close() runs, so only the pre-reap state is observable in flight.
    else { await waitFor("term.seen file after close SIGTERM", () => existsSync(termPath), Boolean); assert.doesNotThrow(() => process.kill(pid!, 0)); assert.equal(terminalOutcome(service.status(started.runId).outcome), false); }
    await closing; assert.equal(performance.now() - before < 1_000, true); assert.equal(service.status(started.runId).outcome, "outcome_unknown"); assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally { if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } await service.close(); fixture.cleanup(); }
});

test("idempotency never respawns and restart recovery stays outcome_unknown without retry", async () => {
  const fixture = scriptedPackage("setInterval(() => {}, 1_000);"), first = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 5_000, publish: async () => ({ outcome: "applied" }) }); let recovered: ReturnType<typeof createPresetProcessService> | undefined;
  try {
    const started = await first.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" }), duplicate = await first.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" }); assert.equal(duplicate.runId, started.runId);
    await waitFor("first preset run to reach running", () => first.status(started.runId), ({ phase }) => phase === "running"); recovered = createPresetProcessService({ rootDir: fixture.rootDir, userRoot: fixture.userRoot, timeoutMs: 50, publish: async () => { throw new Error("must not retry"); } }); const unknown = recovered.status(started.runId), replay = await recovered.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "crash-once" });
    assert.equal(unknown.outcome, "outcome_unknown"); assert.equal(replay.outcome, "outcome_unknown"); assert.equal(unknown.phases.filter((phase) => phase === "spawned").length, 1); assert.equal(unknown.phases.at(-1), "outcome_unknown");
  } finally { await recovered?.close(); await first.close(); fixture.cleanup(); }
});

test("permission staging denies authored, Git, and raw paths while declared produces use only the admitted command", async () => {
  const writer = scriptedPackage('const { target } = JSON.parse(process.env.HA_PRESET_INPUT); (await import("node:fs")).writeFileSync(target, "forbidden"); console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));', { inputs: [{ name: "target", type: "string", required: true }] });
  const targets = [path.join(writer.rootDir, "authored.txt"), path.join(writer.rootDir, ".git/config-owned"), path.join(tmpdir(), `ha-raw-${path.basename(writer.rootDir)}`)], denied = createPresetProcessService({ rootDir: writer.rootDir, userRoot: writer.userRoot, timeoutMs: 1_000, publish: async () => { throw new Error("not reached"); } });
  try { for (const [index, target] of targets.entries()) { const started = await denied.start({ presetId: "user-canary", entrypoint: "check", inputs: { target }, idempotencyKey: `denied-${index}` }), result = await waitFor(`permission denial for ${target}`, () => denied.status(started.runId), ({ outcome }) => outcome === "failed"); assert.equal(result.code, "child_exit"); assert.equal(existsSync(target), false); } } finally { await denied.close(); writer.cleanup(); }

  const producer = scriptedPackage('console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [{ capabilityId: "policy:task-create/v1", payload: { title: "Produced", taskId: "task-produced" } }] }));', { produces: [{ id: "policy:task-create/v1", kind: "command", version: "1" }] }), published: Array<Record<string, unknown>> = [], service = createPresetProcessService({ rootDir: producer.rootDir, userRoot: producer.userRoot, timeoutMs: 1_000, admitProduce: (kind) => kind === "task-create", publish: async (action) => { published.push(action); return { outcome: "applied" }; } });
  try { const started = await service.start({ presetId: "user-canary", entrypoint: "check", inputs: { title: "Canary" }, idempotencyKey: "produce" }), result = await waitFor("produced preset run to reach applied", () => service.status(started.runId), ({ outcome }) => outcome === "applied"); assert.equal(result.outcome, "applied"); assert.deepEqual(published, [{ kind: "task-create", title: "Produced", taskId: "task-produced" }]); } finally { await service.close(); producer.cleanup(); }
});

function scriptedPackage(script: string, entrypoint: Record<string, unknown> = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-process-")), userRoot = path.join(rootDir, ".harness/presets"), source = path.join(rootDir, "source/user-canary");
  write(path.join(source, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "user-canary", title: "User Canary", vertical: "software/coding", version: "3.0.0", kind: "process-action", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], entrypoints: { check: { type: "script", intent: "Run canary", inputs: [{ name: "title", type: "string", required: true }], requires: [], produces: [], sideEffects: [], command: "scripts/check.mjs", ...entrypoint } }, profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" }));
  write(path.join(source, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Canary\nwhenToUse: Verify process actions.\n---\n# Canary\n"); write(path.join(source, "scripts/check.mjs"), script); installPresetPackage({ source, userRoot });
  return { rootDir, userRoot, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}
function inheritedScriptPackage() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-inherited-")), userRoot = path.join(rootDir, ".harness/presets"), source = path.join(rootDir, "source"), manifest = (id: string, extra: Record<string, unknown>) => ({ schema: "preset-manifest/v3", id, title: id, vertical: "software/coding", version: "3.0.0", kind: "process-action", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline", ...extra });
  const parent = path.join(source, "base-canary"), leaf = path.join(source, "leaf-canary"); write(path.join(parent, "preset.json"), JSON.stringify(manifest("base-canary", { entrypoints: { check: { type: "script", intent: "Inherited check", inputs: [{ name: "title", type: "string", required: true }], requires: [], produces: [], sideEffects: [], command: "scripts/check.mjs" } } }))); write(path.join(parent, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Base\nwhenToUse: Run inherited scripts.\n---\n# Base\n"); write(path.join(parent, "scripts/check.mjs"), 'console.log(JSON.stringify({ schema: "preset-script-result/v1", produces: [] }));'); write(path.join(leaf, "preset.json"), JSON.stringify(manifest("leaf-canary", { extends: "base-canary" }))); write(path.join(leaf, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Leaf\nwhenToUse: Inherit the base.\n---\n# Leaf\n"); const installed = installPresetPackage({ source: parent, userRoot }); installPresetPackage({ source: leaf, userRoot });
  return { rootDir, userRoot, parentObject: path.join(userRoot, "preset-objects", installed.digest), cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}
function write(target: string, body: string): void { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); }
function terminalOutcome(outcome: string): boolean { return ["applied", "op_rejected", "failed", "outcome_unknown"].includes(outcome); }
async function waitFor<T>(description: string, read: () => T, done: (value: T) => boolean): Promise<T> { let last: T; for (let attempt = 0; attempt < 500; attempt += 1) { last = read(); if (done(last)) return last; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`Timed out waiting for ${description}; last observed: ${JSON.stringify(last!)}`); }
