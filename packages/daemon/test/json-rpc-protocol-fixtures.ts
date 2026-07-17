import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalControllerService } from "../../application/src/index.ts";
import { createInMemoryTerminalSessionService } from "../../gui/src/terminal/session-registry.ts";
import {
  createJsonRpcProtocolServer,
  makePeopleRosterIdentityAdminSnapshot,
  makeTransportDerivedIdentityProvider,
  peopleRosterFromDocument,
  personRegistryFromLegacyRoster,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PeopleRoster
} from "../src/index.ts";

const fixtureRoot = path.resolve(fileURLToPath(new URL("../fixtures/protocol", import.meta.url)));

export function makeServer(overrides: Partial<Parameters<typeof createJsonRpcProtocolServer>[0]> = {}) {
  return createJsonRpcProtocolServer({
    daemonId: "daemon-test",
    repos: [{ repoId: "canonical", canonicalRoot: "/tmp/canonical" }],
    services: {
      LocalControllerService: emptyLocalController(),
      TerminalSessionService: createInMemoryTerminalSessionService({ createId: () => "term-1" })
    },
    ...overrides
  });
}

export function emptyLocalController(): LocalControllerService {
  return {
    getAgentRuntimes: async () => ({ ok: false, error: { code: "agent_runtime_unavailable", hint: "not configured" } }),
    getAgentHolders: async () => ({ ok: true, schema: "agent-holder-projection/v1", rebuildable: true, rows: [] }),
    profiles: async () => ({ ok: true, schema: "agent-runtime-auth-profiles/v1", profiles: [] }),
    spawn: async () => ({ ok: false, error: { code: "agent_runtime_control_unavailable", hint: "not configured" } }),
    attach: async () => ({ ok: false, error: { code: "agent_runtime_control_unavailable", hint: "not configured" } }),
    status: async () => ({ ok: true, schema: "agent-runtime-session-status/v1", sessions: [] }),
    events: async () => ({ ok: true, events: [], nextCursor: 0 }),
    result: async () => ({ ok: false, error: { code: "agent_runtime_control_unavailable", hint: "not configured" } }),
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

export function commandRunRequest(actionKind: string, id: string, rootDir = "/tmp/canonical"): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "repo.command.run",
    params: {
      repo: { repoId: "canonical" },
      payload: {
        command: {
          rootDir,
          json: true,
          action: { kind: actionKind }
        }
      }
    }
  };
}

export function readFixture(name: string): JsonRpcRequest {
  return readJson(name) as JsonRpcRequest;
}

export function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));
}

export function resultReceipt(response: JsonRpcResponse | ReadonlyArray<JsonRpcResponse> | undefined): {
  readonly ok: boolean;
  readonly schema: string;
  readonly command: string;
  readonly action?: string;
  readonly error?: { readonly code?: string };
  readonly items?: ReadonlyArray<unknown>;
  readonly details: Record<string, any>;
} {
  assert.ok(response && !Array.isArray(response));
  assert.equal("result" in response, true);
  return response.result as {
    readonly ok: boolean;
    readonly schema: string;
    readonly command: string;
    readonly action?: string;
    readonly error?: { readonly code?: string };
    readonly items?: ReadonlyArray<unknown>;
    readonly details: Record<string, any>;
  };
}

export function sampleRoster(): PeopleRoster {
  return peopleRosterFromDocument([
    "schema: harness-people/v1",
    "people:",
    "  - personId: person_alice",
    "    displayName: Alice Admin",
    "    primaryEmail: alice@example.com",
    "    roles: [owner]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: alice",
    "      - kind: email-address",
    "        issuer: email:primary",
    "        subject: alice@example.com",
    "  - personId: person_viewer",
    "    displayName: Victor Viewer",
    "    roles: [observer]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: viewer",
    "  - personId: person_maint",
    "    displayName: Mina Maintainer",
    "    primaryEmail: maint@example.com",
    "    roles: [maintainer]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: maint",
    "  - personId: person_arbiter",
    "    displayName: Ari Arbiter",
    "    primaryEmail: ari@example.com",
    "    roles: [arbiter]",
    "    credentials:",
    "      - kind: ssh-username",
    "        issuer: host:team-host",
    "        subject: ari",
    "roles:",
    "  - roleId: owner",
    "    commandClasses: [admin, repo-write, repo-read, arbiter]",
    "  - roleId: observer",
    "    commandClasses: [repo-read]",
    "  - roleId: maintainer",
    "    commandClasses: [repo-write, repo-read]",
    "  - roleId: arbiter",
    "    commandClasses: [arbiter, repo-write, repo-read]",
    ""
  ].join("\n"));
}

export function rosterIdentityOptions(roster: PeopleRoster) {
  const personRegistry = personRegistryFromLegacyRoster(roster);
  return {
    personRegistry,
    identityProvider: makeTransportDerivedIdentityProvider(roster, { sshExecIssuer: "host:team-host" }),
    identityAdminSnapshot: makePeopleRosterIdentityAdminSnapshot(roster, personRegistry)
  };
}

export function createHarnessRoot(): string {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-daemon-rbac-"));
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n", "utf8");
  return rootDir;
}
