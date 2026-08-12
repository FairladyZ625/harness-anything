// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkTemplateCommandSurface } from "./check-template-command-surface.mjs";

test("retired template checker accepts the thin command directory without template commands", () => {
  assert.deepEqual(checkTemplateCommandSurface({ legacyRoot: path.join(tmpdir(), "missing-ha-templates"), commandSource: `usage: "ha task show <id>"` }), { ok: true, failures: [] });
});
test("retired template checker rejects restored assets or a template command", () => { const root = mkdtempSync(path.join(tmpdir(), "old-templates-"));
  try { writeFileSync(path.join(root, "old.md"), "legacy");
    const result = checkTemplateCommandSurface({ legacyRoot: root, commandSource: `usage: "ha template render <id>"` });
    assert.equal(result.ok, false); assert.match(result.failures.join("\n"), /retired seeded templates/u); assert.match(result.failures.join("\n"), /retired template product surface/u);
  } finally { rmSync(root, { recursive: true, force: true }); } });
