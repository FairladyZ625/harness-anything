// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { deriveRoleBindings, mergePeopleRosterDocuments } from "../../kernel/src/index.ts";
import { peopleRosterFromDocument } from "../src/identity/people-roster.ts";

const legacyRoster = `schema: harness-people/v1
people:
  - personId: person_zeyu
    displayName: "Zeyu Li"
    primaryEmail: "lizeyu990625@gmail.com"
    roles: [owner]
    credentials:
      - kind: unix-socket-owner-boundary
        issuer: host:MacBook-Pro.local
        subject: 501
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
`;

function bootstrapRoster(people: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ schema: "harness-people/v1", people, roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`;
}

const bootstrapPerson = {
  personId: "person_zeyu",
  displayName: "Zeyu Li",
  roles: ["owner"],
  credentials: [{ kind: "unix-socket-owner-boundary", issuer: "host:MacBook-Pro.local", subject: "501" }],
};

function merged(
  source: string,
  destination: string,
): { readonly ok: true; readonly body: string; readonly summary: string } {
  const result = mergePeopleRosterDocuments(source, destination);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result as { readonly ok: true; readonly body: string; readonly summary: string };
}

function refusal(source: string, destination: string): string {
  const result = mergePeopleRosterDocuments(source, destination);
  assert.equal(result.ok, false, result.ok ? `expected a refusal, merged into ${result.body}` : "");
  return (result as { readonly reason: string }).reason;
}

test("a scalar only the source carries survives the union instead of being discarded", () => {
  const result = merged(legacyRoster, bootstrapRoster([bootstrapPerson]));
  const roster = peopleRosterFromDocument(result.body);
  assert.equal(roster.people.length, 1);
  assert.equal(roster.people[0]!.primaryEmail, "lizeyu990625@gmail.com");
  assert.deepEqual(
    [...roster.people[0]!.credentials],
    [{ kind: "unix-socket-owner-boundary", issuer: "host:MacBook-Pro.local", subject: "501" }],
  );
  assert.match(result.summary, /1 enriched in place: person_zeyu/u);
});

test("people and credentials present on only one side are both carried", () => {
  const source = `schema: harness-people/v1
people:
  - personId: person_zeyu
    displayName: "Zeyu Li"
    roles: [owner]
    credentials:
      - kind: email-address
        issuer: example.invalid
        subject: zeyu@example.invalid
  - personId: person_dingwen
    displayName: "Dingwen"
    roles: [reviewer]
    credentials:
      - kind: ssh-username
        issuer: host:build-box
        subject: dingwen
roles:
  - roleId: owner
    commandClasses: [admin, repo-write, repo-read, arbiter]
  - roleId: reviewer
    commandClasses: [repo-read]
`;
  const roster = peopleRosterFromDocument(merged(source, bootstrapRoster([bootstrapPerson])).body);
  assert.deepEqual(
    roster.people.map(({ personId }) => personId),
    ["person_zeyu", "person_dingwen"],
  );
  assert.deepEqual(
    [...roster.people[0]!.credentials].map(({ kind }) => kind),
    ["unix-socket-owner-boundary", "email-address"],
  );
  assert.deepEqual(
    roster.roles.map(({ roleId }) => roleId),
    ["owner", "reviewer"],
  );
  const reviewer = roster.people.find(({ personId }) => personId === "person_dingwen")!;
  assert.deepEqual(
    deriveRoleBindings({
      actor: { principal: { personId: reviewer.personId }, executor: null },
      roleIds: reviewer.roles,
      roleDeclarations: roster.roles,
      target: "settings/repository",
    }).map(({ role }) => role),
    ["repo-read"],
  );
});

test("a union that adds nothing reproduces the destination bytes exactly, so a rerun is a no-op", () => {
  const destination = bootstrapRoster([bootstrapPerson]);
  assert.equal(merged(destination, destination).body, destination);
  const withoutEmail = legacyRoster.replace(/^ +primaryEmail:.*\n/mu, "");
  assert.equal(merged(withoutEmail, destination).body, destination);
});

test("declared RoleBindings union by identity and conflicting validity refuses", () => {
  const declared = {
      actor: { kind: "person", id: "person_zeyu" },
      role: "arbiter",
      target: "settings/repository",
      source: "declared",
      expiresAt: null,
    },
    source = JSON.parse(bootstrapRoster([bootstrapPerson])) as Record<string, unknown>,
    destination = bootstrapRoster([bootstrapPerson]);
  source.bindings = [declared];
  const mergedRoster = peopleRosterFromDocument(merged(`${JSON.stringify(source, null, 2)}\n`, destination).body);
  assert.deepEqual(mergedRoster.bindings, [declared]);

  const conflict = { ...source, bindings: [{ ...declared, expiresAt: "2027-01-01T00:00:00.000Z" }] };
  assert.match(
    refusal(`${JSON.stringify(source, null, 2)}\n`, `${JSON.stringify(conflict, null, 2)}\n`),
    /has different validity on each side/u,
  );
});

test("a person's own roles union but a role's authority definition must agree on both sides", () => {
  const wider = legacyRoster.replace(
    "commandClasses: [admin, repo-write, repo-read, arbiter]",
    "commandClasses: [repo-read]",
  );
  assert.match(
    refusal(wider, bootstrapRoster([bootstrapPerson])),
    /role owner authorizes different command classes on each side.*merging would change what the role grants/u,
  );
});

test("two values for one scalar field refuse rather than silently picking a winner", () => {
  const renamed = legacyRoster.replace('displayName: "Zeyu Li"', 'displayName: "Li Zeyu"');
  assert.match(
    refusal(renamed, bootstrapRoster([bootstrapPerson])),
    /person person_zeyu declares a different displayName on each side/u,
  );
  const other = legacyRoster.replace("lizeyu990625@gmail.com", "someone-else@example.invalid");
  assert.match(
    refusal(other, bootstrapRoster([{ ...bootstrapPerson, primaryEmail: "lizeyu990625@gmail.com" }])),
    /different primaryEmail on each side/u,
  );
});

test("a union that would bind one credential to two people refuses instead of emitting an unloadable roster", () => {
  const claimed = legacyRoster.replace("personId: person_zeyu", "personId: person_other");
  assert.match(
    refusal(claimed, bootstrapRoster([bootstrapPerson])),
    /the union of both rosters is not a valid roster: duplicate credential binding/u,
  );
});

test("an unreadable or foreign document refuses with the reason rather than merging a guess", () => {
  assert.match(
    refusal("schema: harness-people/v2\npeople:\nroles:\n", bootstrapRoster([bootstrapPerson])),
    /schema must be harness-people\/v1 on both sides.*source="harness-people\/v2"/u,
  );
  assert.match(
    refusal("not a roster at all\n", bootstrapRoster([bootstrapPerson])),
    /does not parse as a roster on both sides/u,
  );
});
