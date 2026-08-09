// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLocalCliActorAttribution } from "../src/composition/local-principal.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";

test("missing machine identity reports the resolved daemon user root and roster path", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-principal-"));
  try {
    ensureTestHarnessIdentity(rootDir);
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      ""
    ].join("\n"), "utf8");
    const userRoot = path.join(rootDir, "custom daemon root");
    const machineRosterPath = path.join(userRoot, "people.yaml");

    assert.throws(
      () => resolveLocalCliActorAttribution(
        { rootDir },
        {
          HARNESS_ACTOR: "agent:codex",
          HARNESS_GIT_AUTHOR_NAME: "Harness Writer",
          HARNESS_GIT_AUTHOR_EMAIL: "writer@example.test",
          HARNESS_DAEMON_USER_ROOT: userRoot
        }
      ),
      (error) => {
        assert.equal(
          (error as Error).message,
          `Local writes require a machine identity. Resolved daemon user root: ${userRoot}. Machine roster path: ${machineRosterPath}. Run: ha init with HARNESS_GIT_AUTHOR_NAME and HARNESS_GIT_AUTHOR_EMAIL set, or add the current host/uid credential to ${machineRosterPath}.`
        );
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
