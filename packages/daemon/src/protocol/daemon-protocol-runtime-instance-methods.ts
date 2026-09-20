import { optionalEnum, shape } from "./daemon-protocol-gui-types.ts";

export const runtimeInstanceMethods = Object.freeze([
  {
    id: "repo.agentRuntime.batch",
    phase: "Runtime-B",
    method: "repo.agentRuntime.batch",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ declaration: "string", executor: "json?" }),
    }),
  },
  {
    id: "repo.agentRuntime.sessions.await",
    phase: "Runtime-B",
    method: "repo.agentRuntime.sessions.await",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({
        runtimeSessionIds: "array?",
        taskIds: "array?",
        mode: optionalEnum(["any", "all"] as const),
      }),
    }),
  },
  {
    id: "repo.agent.create",
    phase: "Runtime-B",
    method: "repo.agent.create",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({
        runtimeInstanceId: "string",
        agentId: "string",
        prompt: "string",
        effort: "string?",
        model: "string?",
        cwd: "json?",
        taskId: "string-null?",
        executor: "json?",
      }),
    }),
  },
  {
    id: "daemon.runtimeInstance.create",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.create",
    requiresRepo: false,
    params: shape({
      payload: shape(
        {
          instanceId: "string",
          name: "string",
          kindId: "string",
          installationId: "string?",
          providerId: "string",
          models: "array",
          defaultModel: "string?",
          permissionMode: "string?",
          isolationState: "string?",
          authMode: "string",
          credentialRef: "string?",
        },
        true,
      ),
    }),
    guiBridgeMethod: "createRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.list",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.list",
    requiresRepo: false,
    params: shape({ payload: shape({ all: "boolean?", probe: "boolean?" }) }),
    guiBridgeMethod: "listRuntimeInstances",
  },
  {
    id: "daemon.runtimeInstance.show",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.show",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string", probe: "boolean?" }) }),
    guiBridgeMethod: "showRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.update",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.update",
    requiresRepo: false,
    params: shape({
      payload: shape({
        instanceId: "string",
        name: "string?",
        installationId: "string?",
        models: "array?",
        defaultModel: "string?",
        baseUrl: "string?",
        effort: "string?",
        permissionMode: "string?",
        isolationState: "string?",
        fast: "boolean?",
        enabled: "boolean?",
      }),
    }),
    guiBridgeMethod: "updateRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.delete",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.delete",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string" }) }),
    guiBridgeMethod: "deleteRuntimeInstance",
  },
  {
    id: "daemon.runtimeInstance.githubCredential.set",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.githubCredential.set",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string", githubCredentialRef: "string" }) }),
  },
  {
    id: "daemon.runtimeInstance.githubCredential.unset",
    phase: "Runtime-Instances-S1",
    method: "daemon.runtimeInstance.githubCredential.unset",
    requiresRepo: false,
    params: shape({ payload: shape({ instanceId: "string" }) }),
  },
] as const);

export const runtimeInstanceAuthMethods = Object.freeze([
  {
    id: "repo.runtimeInstance.auth.login",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.login",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
    guiBridgeMethod: "signInRuntimeInstance",
  },
  {
    id: "repo.runtimeInstance.auth.logout",
    phase: "Runtime-Instances-S3",
    method: "repo.runtimeInstance.auth.logout",
    requiresRepo: true,
    params: shape({
      repo: shape({ repoId: "string" }),
      payload: shape({ instanceId: "string", idempotencyKey: "string" }),
    }),
    guiBridgeMethod: "signOutRuntimeInstance",
  },
] as const);
