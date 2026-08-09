// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { materializerCommandResult } from "../src/commands/core/materializer.ts";

test("materializer operational recovery command uses the resolved custom authored root", () => {
  const rootDir = path.resolve("/tmp/materializer custom root");
  const authoredRoot = path.join(rootDir, ".custom ledger");
  const result = materializerCommandResult({
    dryRun: false,
    merged: 0,
    considered: 0,
    branches: [],
    warnings: ["trunk branch main does not exist"]
  }, {
    rootDir,
    layoutOverrides: { authoredRoot: ".custom ledger" }
  });
  const warning = result.warnings?.[0] as { readonly nextCommand?: string } | undefined;
  const expectedCommand = `git -C '${authoredRoot}' branch --list`;

  assert.equal(warning?.nextCommand, expectedCommand);
  assert.equal(
    result.error?.hint,
    `Materializer merged 0 branches; failed 1: trunk branch main does not exist. Next: ${expectedCommand}`
  );
});
