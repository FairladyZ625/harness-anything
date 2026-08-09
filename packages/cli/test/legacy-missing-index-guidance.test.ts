// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { runNewTaskFromLegacy } from "../src/commands/legacy-rebuild.ts";
import { runLegacyVerify } from "../src/commands/migration.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";

test("legacy rebuild missing-index branch renders concrete commands before composition", () => {
  withTempRoot((rootDir) => {
    const result = Effect.runSync(runNewTaskFromLegacy(
      rootDir,
      { kind: "new-task", fromLegacyId: "legacy_missing" } as never,
      () => { throw new Error("missing-index branch must not create a write coordinator"); }
    ));

    assert.equal(result.ok, false);
    assert.equal(
      result.error?.hint,
      `harness/legacy/index.json is missing. Run \`ha legacy index --help\` to identify and index the actual legacy source path, then rerun \`ha --root ${shellArgument(rootDir)} task create --from-legacy legacy_missing\`.`
    );
  });
});

test("missing legacy index guidance uses the resolved authored root and shell-safe repository root", () => {
  withTempRoot((temporaryRoot) => {
    const rootDir = path.join(temporaryRoot, "workspace's root");
    mkdirSync(rootDir, { recursive: true });
    const rootInput = {
      rootDir,
      layoutOverrides: { authoredRoot: ".custom-harness", projectRootBoundary: true }
    };
    const rebuild = Effect.runSync(runNewTaskFromLegacy(
      rootInput,
      { kind: "new-task", fromLegacyId: "legacy special" } as never,
      () => { throw new Error("missing-index branch must not create a write coordinator"); }
    ));
    const verify = runLegacyVerify(rootInput, { kind: "legacy-verify" });
    const root = shellArgument(rootDir);

    assert.equal(
      rebuild.error?.hint,
      `.custom-harness/legacy/index.json is missing. Run \`ha legacy index --help\` to identify and index the actual legacy source path, then rerun \`ha --root ${root} task create --from-legacy 'legacy special'\`.`
    );
    assert.equal(
      verify.error?.hint,
      `.custom-harness/legacy/index.json is missing. Run \`ha legacy index --help\` to identify and index the actual legacy source path, then run \`ha --root ${root} legacy verify\`.`
    );
  });
});

function withTempRoot<T>(run: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-legacy-guidance-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    return run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
