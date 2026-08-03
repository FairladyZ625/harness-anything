// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalCliActorAttribution } from "../src/composition/local-principal.ts";
import { withTestHarnessRoot } from "./helpers/git-fixtures.ts";

test("malformed actor flag names the configured principal in its repair example", () => {
  withTestHarnessRoot((rootDir) => {
    assert.throws(
      () => resolveLocalCliActorAttribution(
        { rootDir },
        {
          HARNESS_ACTOR: "",
          HARNESS_GIT_AUTHOR_NAME: "Harness Writer",
          HARNESS_GIT_AUTHOR_EMAIL: "writer@example.test"
        },
        "person_zeyu"
      ),
      /--actor must use kind:id form, for example human:person_test/u
    );
  });
});
