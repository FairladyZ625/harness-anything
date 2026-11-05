// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveE2EProbeElectronForTest } from "../e2e-probe.mjs";

// Use the same native display/Electron availability contract as driver.test.mjs.
// This entry makes the GUI catalog scenario callable from the isolated dispatcher.
test("the real hidden task page arranges one round and shows the actual failure receipt", { timeout: 300000 }, (t) => {
  const root = path.resolve(import.meta.dirname, "../.."),
    runtime = resolveE2EProbeElectronForTest(root);
  if (!runtime.available) {
    t.skip(runtime.reason);
    return;
  }
  t.after(runtime.close);
  const out = mkdtempSync(path.join(tmpdir(), "gui-rework-shots-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const args = [
    path.join(root, "tools/gui-e2e.mjs"),
    "--lane",
    "isolated",
    "--scenario",
    "task-rework",
    "--shots",
    out,
  ];
  let result;
  try {
    const diagnostics = execFileSync(process.execPath, args, {
      cwd: root,
      env: runtime.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (diagnostics.trim()) t.diagnostic(diagnostics.trim());
    // The runner persists its authoritative result. Fixture child diagnostics are not
    // a second machine-result protocol to parse.
    const runs = readdirSync(out, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("gui-e2e-"),
    );
    assert.equal(runs.length, 1);
    result = JSON.parse(readFileSync(path.join(out, runs[0].name, "result.json"), "utf8"));
  } finally {
    // Emit only intended screenshots/measurements so the dispatcher's remote stdout can carry
    // review evidence back without exposing profiles, browser storage or fixture credentials.
    const collect = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(file);
        else if (entry.name.endsWith(".png"))
          t.diagnostic(
            `GUI_REWORK_IMAGE ${JSON.stringify({ name: entry.name, base64: readFileSync(file).toString("base64") })}`,
          );
        else if (entry.name === "task-rework-evidence.json" || entry.name === "window-state.json")
          t.diagnostic(
            `GUI_REWORK_EVIDENCE ${JSON.stringify({ name: entry.name, value: JSON.parse(readFileSync(file, "utf8")) })}`,
          );
      }
    };
    collect(out);
  }
  assert.equal(result.outcome, "healthy", JSON.stringify(result));
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0].id, "task-rework");
});
