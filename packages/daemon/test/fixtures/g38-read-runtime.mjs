// Compose the production read handlers/executors over the measured backend. Writer-resident
// reads may await Git or policy work; invoking those via the query-only worker's synchronous
// session would reject before the read runs, which is not a cost measurement.
import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { fakeKeycloak } from "../keycloak.fixtures.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { taskShowFromProjection } from "../../src/repo-cell-completion.ts";
import { createRepoCellActionContext } from "../../src/repo-cell-action-context.ts";
import { createRepoCellApi } from "../../src/repo-cell-api.ts";
import { makeRepoCellSettingsState } from "../../src/repo-cell-settings-state.ts";
import { makeEntityActionCatalogExecutor } from "../../src/entity-action-catalog-executor.ts";
import { makeAgentActionRuntime, makeSquadActionRuntime } from "../../src/squad-action-runtime.ts";
import { makeSettingsActionRuntime } from "../../src/settings-action-runtime.ts";
import { makePersonActionRuntime } from "../../src/person-action-runtime.ts";
import { makeScheduleActionRuntime } from "../../src/schedule-action-runtime.ts";
import { executeRepoReadAction } from "../../src/repo-cell-action-dispatch.ts";
import { dispatchRead } from "../../src/repo-cell-command.ts";
import { requiredCellText } from "../../src/repo-cell-settlement.ts";
import { cellCodedError } from "../../src/repo-cell-errors.ts";
import { repositoryRuntimeReads } from "../../src/repository-runtime-reads.ts";

export async function createReadFixtureRuntime({ projection, store, rootDir }, now) {
  const input = { repoId: "g38-read", runtimeInstances: () => [] },
    unsupportedWrite = () => {
      throw new Error("G38 read measurement attempted writer work");
    };
  let settings,
    executor,
    actions,
    knownTaskIds = null;
  const context = createRepoCellActionContext({
    input,
    rootDir,
    now,
    publicPublication: (value) => value,
    getProjection: () => projection,
    getStore: () => store,
    getEntityActionExecutor: () => executor,
    getEntityActionRuntimes: () => actions,
    getService: unsupportedWrite,
    getSettings: () => settings.read(),
    getRecovery: () => ({ status: "ready" }),
    getRecoveryUncertain: () => false,
    setRecoveryUncertain: unsupportedWrite,
    getKnownTaskIds: () => knownTaskIds,
    setKnownTaskIds: (value) => {
      knownTaskIds = value;
    },
    getSquadCoordinator: () => ({}),
  });
  Object.assign(context, {
    mode: "local",
    runtimeSpawner: { spawn: unsupportedWrite },
    showTask: (id) => taskShowFromProjection(rootDir, projection, id),
  });
  settings = makeRepoCellSettingsState(context);
  Object.assign(context, { settings });
  executor = makeEntityActionCatalogExecutor({
    rootDir,
    repositoryId: input.repoId,
    projection,
    store,
    now,
    sessionIdentity: unsupportedWrite,
    readSettings: () => settings.readRepository(),
  });
  actions = {
    entity: {
      agent: makeAgentActionRuntime(context),
      squad: makeSquadActionRuntime(context),
      person: makePersonActionRuntime(context),
      settings: makeSettingsActionRuntime(context, settings),
      schedule: makeScheduleActionRuntime(context, () => settings.read().worktree),
    },
  };
  const api = createRepoCellApi({
    extracted: context,
    mode: "local",
    input,
    state: "attached",
    rootDir,
    projection,
    store,
    now,
    settings,
    runtimeReads: repositoryRuntimeReads(projection, store, now, rootDir, false),
    dispatchRead,
    requiredCellText,
    cellCodedError,
    latched: unsupportedWrite,
  });
  const url = "http://g38-fixture.invalid",
    personId = "person-g38",
    realm = fakeKeycloak(`${url}/realms/harness`),
    provider = new KeycloakPolicyAdapter(
      { url, realm: "harness", resourceServerClientId: "harness-center" },
      realm.fetch,
    ),
    keycloakCenter = async () => ({
      url,
      realm: "harness",
      clientId: "harness-center",
      provider,
      accessToken: "center-token",
    });
  const accessToken = realm.account(personId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = realm.fetch;
  await provider.syncBasePolicy("center-token");
  realm.permit(personId, input.repoId, ["task-start", "task-assign"]);
  const binding = {
      actor: { principal: { personId }, executor: null },
      source: "local",
      keycloakAuthorization: {
        session: {
          provider,
          personId,
          accessToken,
          url,
          realm: "harness",
          clientId: "harness-center",
        },
        center: keycloakCenter,
      },
    },
    userRoot = path.join(rootDir, ".harness/g38-user-root");
  mkdirSync(userRoot, { recursive: true });
  writeFileSync(
    path.join(userRoot, "registry.json"),
    JSON.stringify({
      schema: "harness-daemon-registry/v2",
      connections: [{ id: "local", kind: "local", displayName: "Fixture", state: "enabled" }],
      repos: [
        {
          repoId: input.repoId,
          displayName: "G38",
          canonicalRoot: rootDir,
          authoredBranch: "main",
          mode: "local",
          connectionId: "local",
          state: "enabled",
          registeredAt: now(),
        },
      ],
    }),
  );
  return {
    ...api,
    binding,
    nodeBinding: { ...binding, source: { kind: "node", nodeId: "node-g38" } },
    keycloakCenter,
    userRoot,
    settings,
    status: () => ({ state: "attached", mode: "local", rootDir, repoId: input.repoId }),
    read: api.read,
    run: (action, binding) => executeRepoReadAction(context, action, binding),
    close: async () => {
      globalThis.fetch = originalFetch;
    },
  };
}
