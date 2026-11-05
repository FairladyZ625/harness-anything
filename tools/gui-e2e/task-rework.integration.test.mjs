// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Keep the scenario callable from the isolated dispatcher as well as the GUI catalog. Linux
// uses the repository's existing xvfb-run convention inside the disposable test environment.
test("the real hidden task page arranges one round and shows the actual failure receipt", { timeout: 300000 }, (t) => {
  const root = path.resolve(import.meta.dirname, "../.."),
    out = mkdtempSync(path.join(tmpdir(), "gui-rework-shots-"));
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
    const text =
      process.platform === "linux" && !process.env.DISPLAY
        ? execFileSync("xvfb-run", ["--auto-servernum", process.execPath, ...args], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 16 * 1024 * 1024,
          })
        : execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    result = JSON.parse(text);
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
