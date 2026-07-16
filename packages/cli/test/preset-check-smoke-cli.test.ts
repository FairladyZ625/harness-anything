// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runJson, withTempRoot } from "./helpers/preset-script-fixtures.ts";

test("preset list reports registry metadata without running entrypoint smoke", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "list-only-discovery", {
      check: {
        type: "script",
        command: "scripts/missing-check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });

    const listed = runJson(rootDir, ["preset", "list"]);

    assert.equal(listed.ok, true);
    const preset = listed.presets.find((candidate: Record<string, unknown>) => candidate.id === "list-only-discovery");
    assert.equal(preset.valid, true);
    assert.equal(preset.issueCount, 0);
    assert.equal(listed.issues.some((issue: Record<string, unknown>) => issue.entrypoint === "check"), false);

    const inspected = runJson(rootDir, ["preset", "inspect", "list-only-discovery"], false);
    assert.equal(inspected.ok, false);
    assert.equal(inspected.issues[0].code, "preset_entrypoint_script_missing");
  });
});

test("preset inspect and check fail closed when a declared entrypoint script is missing", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "missing-entrypoint", {
      scaffold: {
        type: "script",
        command: "scripts/scaffold.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });

    for (const command of ["inspect", "check"] as const) {
      const result = runJson(rootDir, ["preset", command, "missing-entrypoint"], false);
      assert.equal(result.ok, false);
      assert.equal(result.preset.valid, false);
      assert.equal(result.preset.issueCount, 1);
      assert.equal(result.issues[0].entrypoint, "scaffold");
      assert.equal(result.issues[0].code, "preset_entrypoint_script_missing");
      assert.match(result.error.hint, /ha preset install <preset-folder> --project/u);
    }
  });
});

test("preset check runs the real scope resolver and rejects writes that miss outputRoot", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "wrong-output-scope", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{paths.milestonesRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/wrong-output-scope/scripts/check.mjs", "console.log('must not execute during smoke');\n");

    const result = runJson(rootDir, ["preset", "check", "wrong-output-scope"], false);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].entrypoint, "check");
    assert.equal(result.issues[0].code, "preset_entrypoint_smoke_failed");
    assert.match(result.issues[0].message, /write scope covering its outputRoot/u);
  });
});

test("preset check rejects a present script that cannot be parsed by the runtime", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "syntax-error", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/syntax-error/scripts/check.mjs", "const broken = ;\n");

    const result = runJson(rootDir, ["preset", "check", "syntax-error"], false);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].entrypoint, "check");
    assert.match(result.issues[0].message, /not executable JavaScript/u);
  });
});

test("preset check rejects an entrypoint name absent from the parser capability registry", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "unreachable", {
      capture: {
        type: "script",
        command: "scripts/capture.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/unreachable/scripts/capture.mjs", "console.log('never reached');\n");

    const result = runJson(rootDir, ["preset", "check", "unreachable"], false);

    assert.equal(result.issues[0].code, "preset_entrypoint_runtime_unregistered");
    assert.equal(result.issues[0].entrypoint, "capture");
    assert.match(result.issues[0].message, /capability registry does not expose/u);
    assert.equal(result.issues[0].nextCommand, "ha preset run --help");
  });
});

test("preset check treats a well-formed script-result ok false as runnable", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "failed-result", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/failed-result/scripts/check.mjs", [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: false, report: { reason: 'positive-control' }, produced: [] }));",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "check", "failed-result"]);

    assert.equal(result.ok, true);
    assert.equal(result.preset.valid, true);
    assert.equal(result.report.preflight.runtimeSmoke.ok, true);

    const list = runJson(rootDir, ["preset", "list"]);
    assert.equal(list.presets.find((preset: Record<string, unknown>) => preset.id === "failed-result").valid, true);
    assert.equal(list.issues.some((issue: Record<string, unknown>) => issue.entrypoint === "check"), false);
  });
});

test("preset check rejects scripts that finish without a script-result/v1", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "missing-result", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/missing-result/scripts/check.mjs", "console.log('no result');\n");

    const result = runJson(rootDir, ["preset", "check", "missing-result"], false);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "preset_entrypoint_smoke_failed");
    assert.match(result.issues[0].message, /did not write script-result\/v1/u);
  });
});

test("preset check rejects malformed script-result/v1 output", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "malformed-result", {
      check: {
        type: "script",
        command: "scripts/check.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/malformed-result/scripts/check.mjs", [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const artifacts = path.join(context.outputRoot, 'artifacts');",
      "mkdirSync(artifacts, { recursive: true });",
      "writeFileSync(path.join(artifacts, 'preset-result.json'), '{not-json');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "check", "malformed-result"], false);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "preset_entrypoint_smoke_failed");
    assert.match(result.issues[0].message, /invalid artifacts\/preset-result\.json/u);
  });
});

test("preset audit reports a script ingest rejection instead of aborting the scan", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "unmanaged-output", {
      scaffold: {
        type: "script",
        command: "scripts/scaffold.mjs",
        writes: ["{{outputRoot}}/**"]
      }
    });
    write(rootDir, ".harness/presets/unmanaged-output/scripts/scaffold.mjs", [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(context.outputRoot, { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'undeclared.md'), '# not ingestible\\n');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {}, produced: [] }));",
      ""
    ].join("\n"));

    const result = runJson(rootDir, ["preset", "audit"], false);

    assert.equal(result.error.code, "preset_manifest_invalid");
    assert.equal(result.presets.find((preset: Record<string, unknown>) => preset.id === "unmanaged-output").valid, false);
    const issue = result.issues.find((candidate: Record<string, unknown>) =>
      candidate.entrypoint === "scaffold" && typeof candidate.message === "string" && candidate.message.includes("SEMANTIC_DIFF_REQUIRED"));
    assert.ok(issue);
    assert.match(issue.message, /SEMANTIC_DIFF_REQUIRED/u);
  });
});

test("usage-acceptance regression fixture reports each broken entrypoint and turns valid only after all three are repaired", () => {
  withTempRoot((rootDir) => {
    writePreset(rootDir, "usage-acceptance", {
      capture: { type: "script", command: "scripts/capture.mjs", writes: ["{{outputRoot}}/**"] },
      "scaffold-plan": { type: "script", command: "scripts/scaffold-plan.mjs", writes: ["{{outputRoot}}/**"] },
      check: { type: "script", command: "scripts/check.mjs", writes: ["{{paths.milestonesRoot}}/**"] }
    });
    write(rootDir, ".harness/presets/usage-acceptance/scripts/check.mjs", "console.log('check');\n");

    const broken = runJson(rootDir, ["preset", "check", "usage-acceptance"], false);
    assert.equal(broken.preset.valid, false);
    assert.deepEqual(broken.issues.map((issue: Record<string, unknown>) => issue.entrypoint), [
      "capture",
      "scaffold-plan",
      "check"
    ]);

    writePreset(rootDir, "usage-acceptance", {
      plan: { type: "script", command: "scripts/scaffold-plan.mjs", writes: ["{{outputRoot}}/**"] },
      scaffold: { type: "script", command: "scripts/capture.mjs", writes: ["{{outputRoot}}/**"] },
      check: { type: "script", command: "scripts/check.mjs", writes: ["{{outputRoot}}/**"] }
    });
    write(rootDir, ".harness/presets/usage-acceptance/scripts/capture.mjs", successfulScript());
    write(rootDir, ".harness/presets/usage-acceptance/scripts/scaffold-plan.mjs", successfulScript());
    write(rootDir, ".harness/presets/usage-acceptance/scripts/check.mjs", successfulScript());

    const repaired = runJson(rootDir, ["preset", "check", "usage-acceptance"]);
    assert.equal(repaired.preset.valid, true);
    assert.equal(repaired.preset.issueCount, 0);
  });
});

function writePreset(rootDir: string, id: string, entrypoints: Record<string, unknown>): void {
  write(rootDir, `.harness/presets/${id}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id,
    title: id,
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints,
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
      completionGates: [],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }, null, 2));
}

function write(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function successfulScript(): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {}, produced: [] }));",
    ""
  ].join("\n");
}
