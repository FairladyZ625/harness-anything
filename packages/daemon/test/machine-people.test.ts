// harness-test-tier: fast
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureMachinePeopleRoster } from "../src/identity/machine-people.ts";

test("concurrent machine roster initializers do not overwrite the winning roster", (t) => {
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-machine-people-race-"));
  const peoplePath = path.join(userRoot, "people.yaml");
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (candidate) => candidate === peoplePath ? false : originalExistsSync(candidate);
  syncBuiltinESMExports();
  t.after(() => {
    fs.existsSync = originalExistsSync;
    syncBuiltinESMExports();
    rmSync(userRoot, { recursive: true, force: true });
  });

  ensureMachinePeopleRoster(userRoot, { name: "Alice", email: "alice@example.test" });
  ensureMachinePeopleRoster(userRoot, { name: "Bob", email: "bob@example.test" });

  const roster = readFileSync(peoplePath, "utf8");
  assert.match(roster, /displayName: "Alice"/u);
  assert.doesNotMatch(roster, /displayName: "Bob"/u);
});
