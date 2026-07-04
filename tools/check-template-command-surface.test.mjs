import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkTemplateCommandSurface } from "./check-template-command-surface.mjs";

test("template command surface accepts current registry-derived command names", () => {
  withTempTemplates((rootDir) => {
    writeFileSync(path.join(rootDir, "current.md"), [
      "`ha task transition <id> active`",
      "`ha fact record --task <id> --statement \"Observed\" --source test`",
      "`ha capabilities --json`",
      "`ha decision relate dec_1 --anchor CH1 --type supports --target task/task_1 --rationale \"evidence\"`",
      ""
    ].join("\n"), "utf8");

    const result = checkTemplateCommandSurface({ templateRoot: rootDir });

    assert.equal(result.ok, true);
  });
});

test("template command surface rejects deprecated aliases and unknown commands", () => {
  withTempTemplates((rootDir) => {
    writeFileSync(path.join(rootDir, "stale.md"), [
      "`ha record fact --task <id>`",
      "`ha task verdict <id>`",
      ""
    ].join("\n"), "utf8");

    const result = checkTemplateCommandSurface({ templateRoot: rootDir });

    assert.equal(result.ok, false);
    assert.equal(result.failures.some((failure) => failure.includes("deprecated command")), true);
    assert.equal(result.failures.some((failure) => failure.includes("unknown command surface")), true);
  });
});

function withTempTemplates(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-template-surface-"));
  try {
    mkdirSync(rootDir, { recursive: true });
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
