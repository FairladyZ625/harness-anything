// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  guiLayoutConflictReceipt,
  guiLocalFailureReceipt
} from "../src/main/local-composition-root.ts";

test("GUI configuration failure is not labeled as daemon unavailability", () => {
  assert.deepEqual(
    guiLocalFailureReceipt("settings", new Error("GUI authored-root configuration is invalid")),
    {
      ok: false,
      error: {
        code: "gui_configuration_invalid",
        hint: "GUI daemon configuration is invalid: GUI authored-root configuration is invalid. Correct HARNESS_DAEMON_USER_ROOT or the repository settings before retrying. The daemon was not contacted."
      }
    }
  );
});

test("GUI layout conflict preserves the requested root and the running daemon", () => {
  assert.deepEqual(guiLayoutConflictReceipt(
    { repoId: "canonical", canonicalRoot: "/srv/repo" },
    "/srv/repo/.custom-authored"
  ), {
    ok: false,
    error: {
      code: "daemon_layout_conflict",
      hint: "A Harness daemon is already running for repo canonical, and the GUI could not verify its existing layout against the requested authored root \"/srv/repo/.custom-authored\"; the GUI did not apply that root. Leave the daemon running and keep HARNESS_AUTHORED_ROOT unchanged. Run `ha --repo canonical daemon status --json`; reopen the GUI only after an operator verifies that the daemon uses that authored root."
    }
  });
});
