// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseDirectAdmissionBeforeExecution,
  runWithRepoWriteDirectAdmission
} from "../src/runtime/repo-write-child-admission.ts";

test("direct admission releases at the execution boundary before foreground continuation", async () => {
  let activeAdmissions = 0;
  const events: string[] = [];

  await runWithRepoWriteDirectAdmission(
    () => {
      activeAdmissions += 1;
      events.push("admitted");
      return () => {
        activeAdmissions -= 1;
        events.push("released");
      };
    },
    async (release) => {
      assert.equal(activeAdmissions, 1, "the admission marker protects the sequencer wait");
      const execute = releaseDirectAdmissionBeforeExecution(async () => {
        assert.equal(activeAdmissions, 0, "foreground continuation must not wait on its own admission");
        events.push("executed");
      }, release);
      await execute(undefined);
    }
  );

  assert.equal(activeAdmissions, 0);
  assert.deepEqual(events, ["admitted", "released", "executed"]);
});
