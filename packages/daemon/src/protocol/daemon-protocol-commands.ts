import {
  cliInput,
  defineCliCommand,
  defineRepoReadCommand,
  defineEdgeReplicaQueryOnlyReadCommand,
  generatedSettingsFieldProtocolProjection,
  presetCommands,
  presetMethods,
  type CliInputGroup,
} from "@harness-anything/preset/internal/preset-command-contract";
import type { EntityActionContract } from "@harness-anything/kernel";
import { todoProtocolCommands } from "./daemon-protocol-commands-todo.ts";
import { agentProtocolCommands } from "./daemon-protocol-commands-agent.ts";
import { assignmentProtocolCommands } from "./daemon-protocol-commands-assignment.ts";
import { decisionLifecycleProtocolCommands } from "./daemon-protocol-commands-decision-lifecycle.ts";
import { decisionRelationProtocolCommands } from "./daemon-protocol-commands-decision-relations.ts";
import { docFactProtocolCommands } from "./daemon-protocol-commands-doc-fact.ts";
import { eventProtocolCommands } from "./daemon-protocol-commands-event.ts";
import { runtimeConfigProtocolCommands } from "./daemon-protocol-commands-runtime-config.ts";
import { providerProtocolCommands } from "./daemon-protocol-commands-provider.ts";
import { runtimeFleetProtocolCommands, scheduleProtocolCommands } from "./daemon-protocol-commands-runtime-fleet.ts";
import { taskSurfaceProtocolCommands } from "./daemon-protocol-commands-task-surface.ts";
import { taskExecutionProtocolCommands } from "./daemon-protocol-commands-task.ts";
import { peopleProtocolCommands } from "./daemon-protocol-commands-people.ts";
import { relationProtocolCommands } from "./daemon-protocol-commands-relation.ts";
import {
  daemonGuiActionMethods,
  daemonGuiInvokeFacets,
  daemonStreamFacets,
  providerMethods,
  runtimeInstanceAuthMethods,
  runtimeInstanceMethods,
} from "./daemon-protocol-gui-actions.ts";
import { daemonGuiReadMethods } from "./daemon-protocol-gui-reads.ts";
import { DaemonProtocolContractError, type JsonObject } from "./json-rpc-types.ts";
import { optionalEnum, shape } from "./daemon-protocol-gui-types.ts";
import { AGENDA_PIN_CRITERIA, daemonRepoModeWords } from "./daemon-protocol-vocabulary.ts";

const settingsWriteTopology = {
    commandClass: "repo-write" as const,
    admission: {
      local: "direct" as const,
      "remote-proxy": "rejected" as const,
      "remote-center": "direct" as const,
      "remote-edge": "via-center-forward" as const,
    },
  },
  declaredSettingsInputs = generatedSettingsFieldProtocolProjection.cliInputs.map((input) =>
    cliInput(
      input.name,
      input.kind,
      false,
      { code: "invalid_field" },
      {
        field: input.field,
        description: input.description,
        effect: input.effect,
        group: input.group,
        ...(input.regex ? { regex: input.regex } : {}),
        ...(input.enum ? { enum: input.enum } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.projection ? { projection: input.projection } : {}),
      },
    ),
  ),
  // Annotated locally so the emitted command type references the named import instead of the
  // generator's literal tuple (which declaration emit cannot name portably).
  settingsInputGroups = generatedSettingsFieldProtocolProjection.groups as readonly CliInputGroup[],
  settingsProtocolCommands = Object.freeze([
    defineEdgeReplicaQueryOnlyReadCommand({
      id: "settings-read",
      actionKind: "settings-read",
      phase: "Settings-Kind",
      path: ["settings", "read"],
      summary: "Read the repository Settings entity from the canonical projection.",
      method: "repo.task.read",
      inputs: [],
    }),
    defineEdgeReplicaQueryOnlyReadCommand({
      id: "settings-show",
      actionKind: "settings-read",
      phase: "Settings-Kind",
      path: ["settings", "show"],
      summary: "Alias of settings read: show the repository Settings entity from the canonical projection.",
      method: "repo.task.read",
      inputs: [],
    }),
    defineCliCommand({
      id: "settings-update",
      actionKind: "settings-update",
      phase: "Settings-Kind",
      path: ["settings", "update"],
      summary: "Update the Settings-owned harness.yaml facet through the canonical writer.",
      method: "repo.task.run",
      inputs: [
        ...declaredSettingsInputs,
        cliInput(
          "--gates-from-document",
          "boolean",
          false,
          { code: "invalid_field" },
          {
            format: "import the settings.gates block declared in harness.yaml",
            // One-shot gates import: it shares the gates presentation group rather than trailing
            // with the mechanical --expected-version/--idempotency-key inputs.
            group: "hosting-gates",
          },
        ),
        cliInput(
          "--expected-version",
          "single",
          false,
          {
            code: "invalid_field",
          },
          { regex: "^(?:0|[1-9][0-9]*)$", projection: "number" as const },
        ),
        cliInput("--idempotency-key", "single", false, {
          code: "invalid_field",
        }),
      ],
      inputGroups: settingsInputGroups,
      ...settingsWriteTopology,
    }),
  ]);

const doctorProtocolCommands = Object.freeze([
  defineRepoReadCommand({
    id: "doctor-health",
    actionKind: "doctor-health",
    phase: "W3",
    path: ["doctor", "health"],
    summary:
      "Run the read-only repository health checks behind ha doctor: delivered cuts, executor " +
      "attribution, orphan leases, WIP pressure, caller-visible doc debt, and build drift.",
    method: "repo.task.read",
    inputs: [],
  }),
]);
const entityPinProtocolCommands = Object.freeze([
  defineCliCommand({
    id: "entity-pin",
    phase: "Entity-Pin",
    path: ["pin", "<entity-ref>"],
    summary: `Pin an existing entity only when it is ${AGENDA_PIN_CRITERIA}.`,
    method: "repo.task.run",
    inputs: [],
    ...settingsWriteTopology,
  }),
  defineCliCommand({
    id: "entity-unpin",
    phase: "Entity-Pin",
    path: ["unpin", "<entity-ref>"],
    summary: "Remove an entity from the repository agenda pins.",
    method: "repo.task.run",
    inputs: [],
    ...settingsWriteTopology,
  }),
]);

export const daemonOwnedProtocolCommands = Object.freeze([
  ...entityPinProtocolCommands,
  ...taskSurfaceProtocolCommands,
  ...doctorProtocolCommands,
  ...todoProtocolCommands,
  ...agentProtocolCommands,
  ...assignmentProtocolCommands,
  ...taskExecutionProtocolCommands,
  ...docFactProtocolCommands,
  ...decisionLifecycleProtocolCommands,
  ...decisionRelationProtocolCommands,
  ...relationProtocolCommands,
  ...runtimeConfigProtocolCommands,
  ...providerProtocolCommands,
  ...runtimeFleetProtocolCommands,
  ...scheduleProtocolCommands,
  ...settingsProtocolCommands,
  ...eventProtocolCommands,
  ...peopleProtocolCommands,
] as const);

export const daemonProtocolCommands = Object.freeze([...daemonOwnedProtocolCommands, ...presetCommands] as const);

export const thinCliCommands = Object.freeze(
  daemonProtocolCommands.filter((command) => !("internal" in command && command.internal)).map((command) => command),
);

// Derived from the command registry, never a hand-copied list: a method owned by exactly one CLI
// command names that command for request attribution (repo.agenda.read → agenda). Methods shared
// by several commands stay method-keyed — only the caller's own declaration can disambiguate them.
const commandIdBySoleMethod = (() => {
  const owners = new Map<string, string[]>();
  for (const command of daemonProtocolCommands) {
    if ("internal" in command && command.internal) continue;
    if (!("method" in command) || !command.method) continue;
    owners.set(command.method, [...(owners.get(command.method) ?? []), command.id]);
  }
  return new Map(
    [...owners.entries()].flatMap(([method, ids]) => (ids.length === 1 ? [[method, ids[0]!] as const] : [])),
  );
})();

export function commandIdForDaemonMethod(method: string): string | null {
  return commandIdBySoleMethod.get(method) ?? null;
}

export function resolveThinCliCommand(args: readonly string[]): (typeof daemonProtocolCommands)[number] | undefined {
  const matches = daemonProtocolCommands.filter(
    (entry) => !("internal" in entry && entry.internal) && entry.path.every((token, index) => args[index] === token),
  );
  if (matches.length < 2) return matches[0];
  const target = args[matches[0]!.path.length] ?? "";
  return matches.find((entry) =>
    "positionalFields" in entry
      ? target.startsWith("preset:")
      : "positionalRegex" in entry
        ? new RegExp(entry.positionalRegex, "u").test(target)
        : true,
  );
}

// The Task Action explain catalog must quote the command the router actually
// accepts, so usage comes from the protocol declaration, never a second
// synthesis of the ingress name.
export function taskActionCommandUsage(action: EntityActionContract): string {
  const ingress = action.execution?.ingress;
  if (!ingress) throw new Error(`Task Action ${action.id} has no Task command ingress.`);
  const command = daemonProtocolCommands.find((entry) => entry.id === ingress);
  if (!command) throw new Error(`Task Action ${action.id} ingress ${ingress} has no protocol command.`);
  return command.usage;
}

export function commandDescriptorForAction(kind: string) {
  const descriptor = commandDescriptorByActionKind.get(kind) ?? presetMethodByActionKind.get(kind);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No command descriptor exists for ${kind}.`);
  return descriptor;
}

export function commandClassForAction(kind: string): "repo-read" | "repo-write" | "arbiter" | "admin" {
  const command = commandDescriptorByActionKind.get(kind),
    guiAction = guiActionDescriptorByKind.get(kind);
  return command?.commandClass ?? guiAction?.commandClass ?? commandDescriptorForAction(kind).commandClass;
}

export function repoCellExecutionForAction(kind: string): "query-only" | "writer" {
  const descriptor = commandDescriptorForAction(kind);
  return "repoCellExecution" in descriptor && descriptor.repoCellExecution === "query-only" ? "query-only" : "writer";
}

export function actionForDaemonMethod(method: string, payload: JsonObject): JsonObject & { readonly kind: string } {
  if (method === "repo.agentRuntime.steer") {
    const descriptor = runtimeFleetProtocolCommands.find((entry) => entry.method === method);
    if (!descriptor)
      throw new DaemonProtocolContractError("unsupported_command", `No action descriptor exists for ${method}.`);
    return { ...payload, kind: descriptor.id };
  }
  if (method === "repo.task.run" || method === "repo.task.read") {
    const action = payload.action as JsonObject & { readonly kind: string },
      descriptor = commandDescriptorByActionKind.get(action.kind);
    if (descriptor?.method !== method)
      throw new DaemonProtocolContractError(
        "unsupported_command",
        `${action.kind} requires its closed method descriptor.`,
      );
    return action;
  }
  const descriptor = actionDescriptorByMethod.get(method) ?? protocolCommandByMethod.get(method);
  if (!descriptor)
    throw new DaemonProtocolContractError("unsupported_command", `No action descriptor exists for ${method}.`);
  // A GUI action may pin the closed parts of its action the renderer cannot say
  // (repo.task.pin's pinned-only amend patch); the declared payload is spread last,
  // so the ingress stays the only writer of those fields. Protocol commands without an
  // actionKind resolve to their command id — the read-only allowlist names those ids.
  const command = presetCommandByMethod.get(method),
    defaults =
      "actionDefaults" in descriptor
        ? descriptor.actionDefaults
        : command && "actionDefaults" in command
          ? command.actionDefaults
          : {};
  return { ...defaults, kind: "actionKind" in descriptor ? descriptor.actionKind : descriptor.id, ...payload };
}

const commandDescriptorByActionKind: ReadonlyMap<string, (typeof daemonProtocolCommands)[number]> = new Map(
    [...daemonProtocolCommands].reverse().map((entry) => ["actionKind" in entry ? entry.actionKind : entry.id, entry]),
  ),
  // Methods with their own server branch (agenda, the runtime overview) never travel the
  // contracted command family, but the execution-scope precheck resolves every method through
  // actionForDaemonMethod; the protocol registry answers those before the precheck rejects them.
  protocolCommandByMethod: ReadonlyMap<string, (typeof daemonProtocolCommands)[number]> = new Map(
    daemonProtocolCommands.map((entry) => [entry.method, entry]),
  ),
  presetMethodByActionKind: ReadonlyMap<string, (typeof presetMethods)[number]> = new Map(
    presetMethods.map((entry) => [entry.actionKind, entry]),
  ),
  actionDescriptorByMethod: ReadonlyMap<
    string,
    (typeof presetMethods)[number] | (typeof daemonGuiActionMethods)[number]
  > = new Map([...presetMethods, ...daemonGuiActionMethods].map((entry) => [entry.method, entry])),
  guiActionDescriptorByKind: ReadonlyMap<string, (typeof daemonGuiActionMethods)[number]> = new Map(
    daemonGuiActionMethods.map((entry) => [entry.actionKind, entry]),
  ),
  presetCommandByMethod: ReadonlyMap<string, (typeof presetCommands)[number]> = new Map(
    presetCommands.map((entry) => [entry.method, entry]),
  );

// Method-name sets consumed by the RPC validation entry; built once beside the descriptor maps.
export const daemonMethodNameSets: {
  readonly preset: ReadonlySet<string>;
  readonly guiRead: ReadonlySet<string>;
  readonly guiAction: ReadonlySet<string>;
  readonly stream: ReadonlySet<string>;
} = {
  preset: new Set(presetMethods.map((entry) => entry.method)),
  guiRead: new Set(daemonGuiReadMethods.map((entry) => entry.method)),
  guiAction: new Set(daemonGuiActionMethods.map((entry) => entry.method)),
  stream: new Set(daemonStreamFacets.map((entry) => entry.method)),
};

export const accessAdminOperations = Object.freeze([
  "group-list",
  "group-create",
  "group-update",
  "group-delete",
  "grant",
  "revoke",
  "grant-list",
  "permission-request-create",
  "permission-request-list",
  "permission-request-decide",
  "permission-request-withdraw",
  "effective-permissions",
  "receipt-list",
  "team-list",
  "team-create",
  "team-update",
  "team-delete",
  "team-member-add",
  "team-member-remove",
  "node-list",
  "node-register",
  "node-unregister",
  "edge-join-create",
  "edge-join-status",
  "edge-join-list",
  "edge-join-revoke",
  "device-list",
  "device-rename",
  "device-pause",
  "device-resume",
  "device-remove",
  "device-logout-all",
  "receipt-reconcile",
  "session-lifetime",
  "session-lifetime-set",
] as const);

// The daemon method table is the single source for RPC validation and contract derivation.
// It lives below both modules so validation can read the table without importing the
// contract barrel that re-exports validation.
export const daemonProtocolMethods = Object.freeze([
  {
    id: "protocol.hello",
    phase: "W3",
    method: "protocol.hello",
    requiresRepo: false,
    params: shape({
      protocolVersion: shape({ major: "number", minor: "number" }),
      sessionEnvironment: "json?",
      executionCredential: "string?",
      reportStaleBuild: "boolean?",
      // The CLI dedicates one connection per invocation; it names the command that connection
      // serves so the request logs can key traffic by CLI command instead of transport method.
      invokingCommand: "string?",
    }),
  },
  {
    id: "daemon.status",
    phase: "W3",
    method: "daemon.status",
    requiresRepo: false,
    params: shape({}),
  },
  {
    id: "daemon-node-auto-claim",
    phase: "Edge-Resident-H1",
    method: "daemon.nodeAutoClaim.configure",
    requiresRepo: false,
    params: shape({ policy: "json" }),
  },
  {
    id: "daemon.skillEval.case.add",
    phase: "W3",
    method: "daemon.skillEval.case.add",
    requiresRepo: false,
    params: shape({
      skillId: "string",
      id: "string",
      input: "string",
      hidden: "boolean?",
      expect: "json?",
    }),
  },
  {
    id: "daemon.skillEval.cases.list",
    phase: "W3",
    method: "daemon.skillEval.cases.list",
    requiresRepo: false,
    params: shape({ skillId: "string" }),
  },
  {
    id: "daemon.skillEval.run",
    phase: "W3",
    method: "daemon.skillEval.run",
    requiresRepo: false,
    params: shape({ skillId: "string", version: "string", threshold: "number?" }),
  },
  {
    id: "daemon.stop",
    phase: "W3",
    method: "daemon.stop",
    requiresRepo: false,
    params: shape({}),
  },
  {
    id: "daemon.repo.bootstrap",
    phase: "W3",
    method: "daemon.repo.bootstrap",
    requiresRepo: false,
    params: shape({
      rootDir: "string",
      repoId: "string?",
      personId: "string?",
      displayName: "string?",
      name: "string?",
      addNpmScripts: "boolean?",
      configureOnly: "boolean?",
    }),
  },
  {
    id: "daemon.rbac.manage",
    phase: "W3",
    method: "daemon.rbac.manage",
    requiresRepo: false,
    params: shape({
      operation: optionalEnum([
        "bootstrap",
        "health",
        "start",
        "stop",
        "backup",
        "restore",
        "upgrade",
        "login-begin",
        "login-complete",
        "login",
        "login-poll",
        "device-approval",
        "session",
        "logout",
        "bootstrap-status",
        "bootstrap-admin",
        "invite",
        ...accessAdminOperations,
        "listener",
        "listener-set",
        "edge-join",
        "edge-join-progress",
      ] as const),
      mode: optionalEnum(["managed", "external"] as const),
      repoId: "string?",
      rootDir: "string?",
      url: "string?",
      realm: "string?",
      clientId: "string?",
      clientSecret: "string?",
      backupDir: "string?",
      redirectUri: "string?",
      code: "string?",
      state: "string?",
      username: "string?",
      email: "string?",
      displayName: "string?",
      password: "string?",
      personId: "string?",
      repoIds: "array?",
      groupIds: "array?",
      nodeLabel: "string?",
      operationId: "string?",
      confirm: "boolean?",
      force: "boolean?",
      groupId: "string?",
      teamId: "string?",
      teamName: "string?",
      scopes: "array?",
      composites: "array?",
      expectedVersion: "string?",
      resource: "string?",
      requestId: "string?",
      requestVersion: "number?",
      decision: optionalEnum(["approve", "reject"] as const),
      rationale: "string?",
      sessionLifetimeSeconds: "number?",
      listenAddress: "string?",
      hostname: "string?",
      port: "number?",
      certificateFile: "string?",
      certificateKeyFile: "string?",
      certificateMode: optionalEnum(["self-signed", "domain", "internal-ca"] as const),
      nodeId: "string?",
      systemName: "string?",
      platform: "string?",
      credentialFile: "string?",
      joinId: "string?",
      link: "string?",
      workspaceRoot: "string?",
      quotaBytes: "number?",
      transport: optionalEnum(["direct", "ssh-reverse"] as const),
      sshTarget: "string?",
    }),
  },
  {
    id: "runtime-instance-hosting-credential-set",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.hostingCredential.set",
    requiresRepo: false,
    params: shape({
      payload: shape({
        instanceId: "string",
        provider: optionalEnum(["github", "gitlab"]),
        credentialRef: "string",
      }),
    }),
  },
  {
    id: "runtime-instance-hosting-credential-unset",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.hostingCredential.unset",
    requiresRepo: false,
    params: shape({
      payload: shape({
        instanceId: "string",
        provider: optionalEnum(["github", "gitlab"]),
      }),
    }),
  },
  {
    id: "daemon.repo.register",
    phase: "W3",
    method: "daemon.repo.register",
    requiresRepo: false,
    params: shape({
      rootDir: "string?",
      repoId: "string",
      displayName: "string?",
      mode: optionalEnum(daemonRepoModeWords),
      endpoint: "string?",
      connectionId: "string?",
    }),
  },
  {
    id: "daemon.repo.update",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.repo.update",
    requiresRepo: false,
    params: shape({
      repoId: "string",
      displayName: "string?",
      mode: optionalEnum(daemonRepoModeWords),
      endpoint: "string?",
      connectionId: "string?",
      state: optionalEnum(["enabled", "disabled"] as const),
    }),
  },
  {
    id: "daemon.repo.backup",
    phase: "Repo-Lifecycle",
    method: "daemon.repo.backup",
    requiresRepo: false,
    params: shape({ rootDir: "string", backupDir: "string" }),
  },
  {
    id: "daemon.repo.restoreDrill",
    phase: "Repo-Lifecycle",
    method: "daemon.repo.restoreDrill",
    requiresRepo: false,
    params: shape({ rootDir: "string", backupDir: "string", shadowParent: "string?" }),
  },
  {
    id: "daemon.repo.unbind",
    phase: "W3",
    method: "daemon.repo.unbind",
    requiresRepo: false,
    params: shape({ repoId: "string" }),
  },
  {
    id: "daemon.repo.purge",
    phase: "Repo-Lifecycle",
    method: "daemon.repo.purge",
    requiresRepo: false,
    params: shape({
      repoId: "string",
      scope: { values: ["cache", "all"], optional: false },
      backup: "string?",
      confirm: "string?",
    }),
  },
  {
    id: "daemon.connection.register",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.register",
    requiresRepo: false,
    params: shape({ connectionId: "string?", displayName: "string?", endpoint: "string" }),
  },
  {
    id: "daemon.connection.update",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.update",
    requiresRepo: false,
    params: shape({
      connectionId: "string",
      displayName: "string?",
      endpoint: "string?",
      state: optionalEnum(["enabled", "disabled"] as const),
    }),
  },
  {
    id: "daemon.connection.unregister",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.unregister",
    requiresRepo: false,
    params: shape({ connectionId: "string" }),
  },
  {
    id: "daemon.connection.probe",
    phase: "PLT-EdgeGUI-W2",
    method: "daemon.connection.probe",
    requiresRepo: false,
    params: shape({ endpoint: "string" }),
  },
  {
    id: "repo.task.run",
    phase: "W3",
    method: "repo.task.run",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ action: shape({ kind: "string" }, true) }),
    }),
  },
  {
    id: "repo.agentRuntime.steer",
    phase: "Runtime-B",
    method: "repo.agentRuntime.steer",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ runtimeSessionId: "string?", dispatchId: "string?", prompt: "string" }),
    }),
  },
  {
    id: "repo.task.read",
    phase: "W3",
    method: "repo.task.read",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ action: shape({ kind: "string" }, true) }),
    }),
  },
] as const);

/* Runtime instance method descriptors live in the browser-safe protocol graph. */
export { daemonGuiInvokeFacets, providerMethods, runtimeInstanceAuthMethods, runtimeInstanceMethods };

export const fleetProtocolMethods = Object.freeze([
  {
    id: "daemon.fleet.center.start",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.center.start",
    requiresRepo: false,
    params: shape({
      payload: shape({
        port: "number",
        // Omitted pair: the daemon resolves the login service listener certificate.
        keyPath: "string?",
        certPath: "string?",
        repoId: "string",
        quotaBytes: "number",
        bind: "string?",
        externalUrl: "string?",
        stateRoot: "string?",
      }),
    }),
  },
  {
    id: "daemon.fleet.center.read",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.center.read",
    requiresRepo: false,
    params: shape({ payload: shape({}) }),
  },
  {
    id: "daemon.fleet.center.external-address.read",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.center.external-address.read",
    requiresRepo: false,
    params: shape({ payload: shape({}) }),
  },
  {
    id: "daemon.fleet.center.external-address.set",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.center.external-address.set",
    requiresRepo: false,
    params: shape({ payload: shape({ externalUrl: "string" }) }),
  },
  {
    id: "daemon.fleet.edge.sync",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.edge.sync",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        servername: "string?",
        timeoutMs: "number",
      }),
    }),
  },
  {
    id: "daemon.fleet.task.run",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.task.run",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string",
        servername: "string?",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        waitTimeoutMs: "number?",
        maxAgeMs: "number?",
        maxLagRevisions: "number?",
        workspaceRoot: "string?",
        action: "json",
      }),
    }),
  },
  {
    id: "daemon.fleet.doc.sync",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.doc.sync",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string",
        servername: "string?",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        dryRun: "boolean?",
        paths: "array?",
        timeoutMs: "number?",
      }),
    }),
  },
  {
    id: "daemon.fleet.conflict.exit",
    phase: "Fleet-Wiring",
    method: "daemon.fleet.conflict.exit",
    requiresRepo: false,
    params: shape({
      payload: shape({
        host: "string",
        port: "number",
        caPath: "string",
        nodeId: "string",
        credential: "string",
        servername: "string?",
        repoId: "string",
        viewRoot: "string",
        quotaBytes: "number",
        workspaceRoot: "string",
        action: {
          values: ["resolve", "discard-local", "overwrite-center"],
          optional: false,
        },
        conflictId: "string",
      }),
    }),
  },
] as const);

export const allDaemonProtocolMethods = Object.freeze([
  ...daemonProtocolMethods,
  ...runtimeInstanceMethods,
  ...providerMethods,
  ...runtimeInstanceAuthMethods,
  ...fleetProtocolMethods,
  ...presetMethods,
  ...daemonGuiReadMethods,
  ...daemonGuiActionMethods,
  ...daemonStreamFacets,
]);

export type DaemonRpcDescriptor = (typeof allDaemonProtocolMethods)[number];
export type DaemonRpcMethod = DaemonRpcDescriptor["method"];
