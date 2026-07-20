// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { AuthorityHostCommand } from "../src/index.ts";

type MissingNewTaskTitle = {
  readonly rootDir: "/repo";
  readonly action: {
    readonly kind: "new-task";
    readonly slug: "missing-title";
    readonly allowManualId: false;
    readonly longRunning: false;
    readonly dryRun: false;
  };
};

type MissingRequiredFieldIsRejected = MissingNewTaskTitle extends AuthorityHostCommand ? false : true;
const missingRequiredFieldIsRejected = true satisfies MissingRequiredFieldIsRejected;

test("authority host commands reject missing production fields at compile time", () => {
  assert.equal(missingRequiredFieldIsRejected, true);
});
