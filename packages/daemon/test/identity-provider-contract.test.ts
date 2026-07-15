// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LocalControllerService } from "../../application/src/index.ts";
import { loadDaemonIdentityWithEmail } from "../../cli/src/commands/daemon/identity.ts";
import { readConfiguredLocalPrincipal } from "../../cli/src/composition/local-principal.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  composeIdentityProvider,
  createJsonRpcProtocolServer,
  currentDaemonProtocolVersion,
  makeTransportDerivedIdentityProvider,
  peopleRosterFromDocument,
  personRegistryFromDocument,
  personRegistryFromLegacyRoster,
  validatePeopleRosterReferences,
  type AuthenticationProvider,
  type AuthorizationProvider,
  type IdentityProvider,
  type JsonRpcResponse
} from "../src/index.ts";

test("daemon core asks identity providers only who the credential belongs to and whether the person may act", async () => {
  const calls: string[] = [];
  const authentication: AuthenticationProvider = {
    providerId: "fake-two-question/v1",
    authenticate: async () => {
      calls.push("authenticate");
      return {
        ok: true,
        personId: "person_fake",
        providerId: "fake-two-question/v1",
        credential: { kind: "api-token", issuer: "test", subject: "token-1" }
      };
    }
  };
  const authorization: AuthorizationProvider = {
    authorize: async ({ personId, action }) => {
      calls.push(`authorize:${personId}:${action.commandClass}`);
      return { ok: true };
    }
  };
  const server = makeServer({
    identityProvider: composeIdentityProvider(authentication, authorization),
    personRegistry: personRegistryFromDocument(
      "schema: harness-persons/v1\npeople:\n  - personId: person_fake\n    displayName: Fake Person\n"
    ),
    authContext: { transportKind: "unix-socket" }
  });
  await hello(server);

  const receipt = resultReceipt(await server.handle(repoRequest("repo.tasks.list", {})));

  assert.equal(receipt.ok, true);
  assert.deepEqual(calls, ["authenticate", "authorize:person_fake:repo-read"]);
  assert.equal((receipt.details.actor as { readonly personId?: string }).personId, "person_fake");
});

test("daemon rejects identity-provider results that are absent from or disabled in the core person registry", async () => {
  let personId = "person_missing";
  let authorizationCalls = 0;
  const provider: IdentityProvider = {
    providerId: "fake-integrity/v1",
    authenticate: async () => ({
      ok: true,
      personId,
      providerId: "fake-integrity/v1",
      credential: { kind: "api-token", issuer: "test", subject: personId }
    }),
    authorize: async () => {
      authorizationCalls += 1;
      return { ok: true };
    }
  };
  const server = makeServer({
    identityProvider: provider,
    personRegistry: personRegistryFromDocument([
      "schema: harness-persons/v1",
      "people:",
      "  - personId: person_disabled",
      "    displayName: Disabled Person",
      "    disabled: true",
      ""
    ].join("\n")),
    authContext: { transportKind: "unix-socket" }
  });
  await hello(server);

  const missing = resultReceipt(await server.handle(commandRequest("new-task", "missing-person")));
  personId = "person_disabled";
  const disabled = resultReceipt(await server.handle(commandRequest("new-task", "disabled-person")));

  assert.equal(missing.error?.code, "person_unregistered");
  assert.equal(disabled.error?.code, "person_disabled");
  assert.equal(authorizationCalls, 0);
});

test("split person registry contains no credential or role policy and supplies actor metadata after authentication", async () => {
  const splitRoster = peopleRosterFromDocument([
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: alice",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [repo-write]",
    ""
  ].join("\n"));
  const registry = personRegistryFromDocument(
    "schema: harness-persons/v1\npeople:\n  - personId: person_alice\n    displayName: Alice\n"
  );

  assert.doesNotThrow(() => validatePeopleRosterReferences(registry, splitRoster));
  assert.throws(
    () => validatePeopleRosterReferences(personRegistryFromDocument("schema: harness-persons/v1\npeople:\n"), splitRoster),
    /unregistered personId: person_alice/u
  );
  assert.throws(
    () => personRegistryFromDocument(JSON.stringify({
      schema: "harness-persons/v1",
      people: [{ personId: "person_alice", displayName: "Alice", roles: ["owner"] }]
    })),
    /Unsupported person registry key: roles/u
  );
  const server = makeServer({
    identityProvider: makeTransportDerivedIdentityProvider(splitRoster, { sshExecIssuer: "host:team-host" }),
    personRegistry: registry,
    authContext: {
      transportKind: "ssh-exec",
      sshExecUser: { username: "alice", host: "team-host", source: "ssh-authenticated-exec" }
    }
  });
  await hello(server);
  const receipt = resultReceipt(await server.handle(repoRequest("repo.tasks.list", {})));
  assert.equal((receipt.details.actor as { readonly displayName?: string }).displayName, "Alice");

  const legacy = peopleRosterFromDocument([
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    displayName: Alice Admin",
    "    roles: [owner]",
    "    credentials: []",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [repo-write]",
    ""
  ].join("\n"));
  assert.equal(personRegistryFromLegacyRoster(legacy).find("person_alice")?.displayName, "Alice Admin");
});

test("an existing people.yaml stays authoritative and empty credentials fail as credential_unknown", async (t) => {
  const rootDir = createIdentityRoot("person_local");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "harness/people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_zeyu",
    "    displayName: ZeyuLi",
    "    roles: [owner]",
    "    credentials: []",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n"), "utf8");

  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, "local@example.test");
  const result = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    }
  });

  assert.equal(identity.personRegistry?.find("person_zeyu")?.personId, "person_zeyu");
  assert.equal(identity.personRegistry?.find("person_local"), undefined);
  assert.equal(result?.ok, false);
  if (result && !result.ok) assert.equal(result.code, "credential_unknown");
});

test("a repo without people.yaml inherits the machine people roster", async (t) => {
  const rootDir = createIdentityRoot("person_machine");
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-machine-identity-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  });
  writeFileSync(path.join(userRoot, "people.yaml"), ownerRoster("person_machine"), "utf8");

  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, undefined, undefined, userRoot);
  const authenticated = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    }
  });

  assert.equal(authenticated?.ok && authenticated.personId, "person_machine");
});

test("remote mode rejects socket-owner identity and accepts only a forced-command person", async (t) => {
  const rootDir = createIdentityRoot("person_remote");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const configPath = path.join(rootDir, "harness/harness.yaml");
  writeFileSync(configPath, [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  identity:",
    "    mode: remote",
    ""
  ].join("\n"), "utf8");
  writeFileSync(path.join(rootDir, "harness/people.yaml"), remoteRoster("person_remote"), "utf8");

  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, undefined);
  const local = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    }
  });
  const remote = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    },
    sshForcedCommand: {
      personId: "person_remote",
      canonicalRoot: rootDir,
      source: "sshd-authorized-keys-forced-command"
    }
  });

  assert.equal(identity.mode, "remote");
  assert.equal(local?.ok, false);
  if (local && !local.ok) {
    assert.equal(local.code, "credential_unavailable");
    assert.match(local.message, /local socket-owner identity is disabled/u);
  }
  assert.equal(remote?.ok && remote.personId, "person_remote");
});

test("direct recovery resolves the same machine roster when the project declares only local mode", (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-direct-machine-identity-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "ha-direct-machine-home-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  identity:",
    "    mode: local",
    ""
  ].join("\n"), "utf8");
  mkdirSync(path.join(home, ".harness"), { recursive: true });
  writeFileSync(path.join(home, ".harness/people.yaml"), ownerRoster("person_machine"), "utf8");
  assert.equal(readConfiguredLocalPrincipal(rootDir, { HOME: home }).personId, "person_machine");

  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  identity:",
    "    mode: local",
    "    personId: person_project",
    ""
  ].join("\n"), "utf8");
  assert.throws(
    () => readConfiguredLocalPrincipal(rootDir, { HOME: home }),
    /cannot rebind this machine credential from 'person_machine'/u
  );
});

test("a project overlay overrides the machine credential's person", async (t) => {
  const rootDir = createIdentityRoot("person_project");
  const userRoot = mkdtempSync(path.join(os.tmpdir(), "ha-machine-identity-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  });
  writeFileSync(path.join(userRoot, "people.yaml"), ownerRoster("person_machine"), "utf8");
  writeFileSync(path.join(rootDir, "harness/people.yaml"), ownerRoster("person_project"), "utf8");

  // The machine roster maps this credential to person_machine, but the project
  // people.yaml is an explicit per-repo declaration and wins — silently, by
  // design (company A's identity here, company B's in another repo, one laptop).
  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, undefined, undefined, userRoot);
  const authenticated = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    }
  });

  assert.equal(authenticated?.ok && authenticated.personId, "person_project");
});

test("a roster person with matching credentials but no roles fails as rbac_forbidden", async (t) => {
  const rootDir = createIdentityRoot("person_zeyu");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "harness/people.yaml"), [
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_zeyu",
    "    displayName: ZeyuLi",
    "    roles: []",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${os.hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles: []",
    ""
  ].join("\n"), "utf8");
  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, "zeyu@example.test");
  const server = makeServer({
    identityProvider: identity.identityProvider,
    personRegistry: identity.personRegistry,
    identityAdminSnapshot: identity.identityAdminSnapshot,
    authContext: {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: process.getuid?.() ?? 0,
        source: "unix-socket-filesystem-owner-boundary"
      }
    }
  });
  await hello(server);

  const receipt = resultReceipt(await server.handle(commandRequest("new-task", "empty-roles")));
  assert.equal(receipt.error?.code, "rbac_forbidden");
});

test("the no-roster ownership path is composed from an AuthenticationProvider instead of a synthetic roster", async (t) => {
  const rootDir = createIdentityRoot("person_local");
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const identity = loadDaemonIdentityWithEmail(rootDir, undefined, "local@example.test");
  const authenticated = await identity.identityProvider?.authenticate({
    transportKind: "unix-socket",
    unixSocketOwnerBoundary: {
      ownerUid: process.getuid?.() ?? 0,
      source: "unix-socket-filesystem-owner-boundary"
    }
  });
  const authorized = await identity.identityProvider?.authorize({
    personId: "person_local",
    action: { method: "repo.tasks.progress.append", commandClass: "repo-write" }
  });

  assert.equal("peopleRoster" in identity, false);
  assert.equal(authenticated?.ok && authenticated.personId, "person_local");
  assert.deepEqual(authorized, { ok: true });
});

test("unclassified writes cannot bypass a missing identity provider", async () => {
  let serviceCalls = 0;
  const server = makeServer({
    authContext: { transportKind: "unix-socket" },
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" }),
      CliCommandService: {
        runCommand: async () => {
          serviceCalls += 1;
          throw new Error("unclassified command reached service dispatch");
        }
      }
    }
  });
  await hello(server);

  const receipt = resultReceipt(await server.handle(commandRequest("future-write-action", "unclassified-action")));

  assert.equal(receipt.error?.code, "provider_unavailable");
  assert.equal(serviceCalls, 0);
});

function createIdentityRoot(personId: string): string {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-identity-contract-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  identity:",
    `    personId: ${personId}`,
    `    displayName: ${personId}`,
    ""
  ].join("\n"), "utf8");
  return rootDir;
}

function ownerRoster(personId: string): string {
  return [
    "schema: harness-people/v1",
    "people:",
    `  - personId: ${personId}`,
    `    displayName: ${personId}`,
    "    roles: [owner]",
    "    credentials:",
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${os.hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n");
}

function remoteRoster(personId: string): string {
  return [
    "schema: harness-people/v1",
    "people:",
    `  - personId: ${personId}`,
    `    displayName: ${personId}`,
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-forced-command-person",
    `        issuer: host:${os.hostname()}`,
    `        subject: ${personId}`,
    "      - kind: unix-socket-owner-boundary",
    `        issuer: host:${os.hostname()}`,
    `        subject: ${process.getuid?.() ?? 0}`,
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    ""
  ].join("\n");
}

function makeServer(overrides: Partial<Parameters<typeof createJsonRpcProtocolServer>[0]> = {}) {
  return createJsonRpcProtocolServer({
    daemonId: "identity-contract-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    },
    ...overrides
  });
}

async function hello(server: ReturnType<typeof makeServer>): Promise<void> {
  await server.handle({
    jsonrpc: "2.0",
    id: "hello",
    method: "protocol.hello",
    params: { protocolVersion: currentDaemonProtocolVersion }
  });
}

function repoRequest(method: string, payload: Record<string, unknown>) {
  return { jsonrpc: "2.0" as const, id: method, method, params: { repo: { repoId: "canonical" }, payload } };
}

function commandRequest(action: string, id: string) {
  return {
    ...repoRequest("repo.command.run", { command: { rootDir: "/tmp/canonical", json: true, action: { kind: action } } }),
    id
  };
}

function resultReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined) {
  assert.ok(response && !Array.isArray(response) && "result" in response);
  return response.result as {
    readonly ok: boolean;
    readonly error?: { readonly code?: string };
    readonly details: Record<string, unknown>;
  };
}

function emptyLocalController(): LocalControllerService {
  return {
    getTasks: () => ({ ok: true, tasks: [], warnings: [] }),
    getTaskDetail: async () => ({ ok: true }),
    getTaskDocument: async () => ({ ok: true }),
    getRelationGraph: () => ({ ok: true, edges: [], coverageRows: [], factAnchors: [], warnings: [] }),
    getDecisions: () => ({ ok: true, decisions: [], warnings: [] }),
    getDecisionDetail: () => ({ ok: false, error: { code: "decision_not_found", hint: "missing" } }),
    getTaskFacts: async (payload) => ({ ok: true, taskId: payload.taskId, path: "harness/tasks/task/facts.md", facts: [] }),
    setTaskStatus: async () => ({ ok: true }),
    reviewTask: async () => ({ ok: true }),
    appendTaskProgress: async () => ({ ok: true }),
    rebuildGovernance: () => ({ ok: true, tasks: [], warnings: [] }),
    archiveTask: () => ({ ok: true }),
    openShell: () => ({ ok: true, policy: { displayOnly: true, outputCreatesTaskState: false } })
  };
}
