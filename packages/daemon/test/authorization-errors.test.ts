// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizePersonForMethod,
  makePersonAuthorizationProvider
} from "../src/identity/authorization.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";

test("missing role grant reports the active roster boundary without guessing its source path", () => {
  const roster = peopleRosterFromDocument([
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_probe",
    "    displayName: Probe",
    "    roles: []",
    "    credentials: []",
    "roles: []",
    ""
  ].join("\n"));

  const result = authorizePersonForMethod("person_probe", {
    method: "repo.tasks.review",
    commandClass: "arbiter"
  }, roster);

  assert.deepEqual(result, {
    ok: false,
    code: "rbac_forbidden",
    message: "Person person_probe is forbidden from arbiter method repo.tasks.review because the active PeopleRoster grants none of their assigned roles that command class. This authorization check does not know the roster source path and made no configuration change. Inspect the owning identity configuration and logs; use `ha daemon status --json` only to verify the active daemon before retrying after the role grant is confirmed."
  });
});

test("missing provider grant points to provider composition instead of a roster file", async () => {
  const provider = makePersonAuthorizationProvider("person_probe", []);

  const result = await provider.authorize({
    personId: "person_probe",
    action: {
      method: "repo.tasks.review",
      commandClass: "arbiter"
    }
  });

  assert.deepEqual(result, {
    ok: false,
    code: "rbac_forbidden",
    message: "Person person_probe is forbidden from arbiter method repo.tasks.review because this authorization provider's configured command-class grant is missing. The grant comes from provider composition, not from a roster path, and this check made no configuration change. Inspect the owning authorization configuration and logs; use `ha daemon status --json` only to verify the active daemon before retrying after the grant is confirmed."
  });
});
