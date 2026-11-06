// This preload supplies the same policy and runtime fixtures as the in-process tests to the real resident.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

if (process.argv.includes("--service")) {
  const config = JSON.parse(readFileSync(process.env.HA_READOPTION_CONFIG!, "utf8"));
  const { openBootstrappedRepoCell } = await import("../repo-settings.fixture.ts");
  const { signInPolicyTestUser, withPolicyGroup } = await import("../keycloak-policy.fixtures.ts");
  signInPolicyTestUser(config.userRoot, "resident-worker", [config.repoId], "admin");
  const installation = {
    installationId: "installation-resident-readopt",
    kindId: "codex" as const,
    executablePath: config.provider,
    version: "1.0.0",
    observedAt: "2026-09-18T00:00:00.000Z",
  };
  const definition = {
    schema: "agent-definition-snapshot/v1" as const,
    configVersion: 1,
    instanceId: "codex-resident-readopt",
    installationId: installation.installationId,
    kindId: "codex" as const,
    providerId: "openai",
    model: "codex-model",
    reasoningEffort: null,
    baseUrl: null,
    authMode: "subscription" as const,
  };
  const instance = {
    schemaVersion: 2 as const,
    instanceId: definition.instanceId,
    name: "Resident readopt",
    kindId: "codex" as const,
    installationId: installation.installationId,
    providerId: "openai",
    models: ["codex-model"],
    defaultModel: "codex-model",
    enabled: true,
    permissionMode: "workspace-write" as const,
    codex: {},
    authMode: "subscription" as const,
    authState: "configured" as const,
    authReadiness: { status: "ready" as const, code: null, hint: null },
    isolationState: "enforced" as const,
  };
  let launched = false;
  (globalThis as typeof globalThis & { residentTestOpenCell?: typeof openBootstrappedRepoCell }).residentTestOpenCell =
    async (input) => {
      const cell = await openBootstrappedRepoCell({
        ...input,
        runtimeInstances: () => [instance],
        prepareRuntimeLaunch: async (_id, request) => ({
          definition,
          installation,
          executablePath: config.provider,
          args: ["exec", "--json", "--model", "codex-model", "-"],
          env: process.env,
          cwd: request.cwd,
          prompt: request.prompt,
        }),
      });
      if (!existsSync(config.sessionFile) && !launched) {
        launched = true;
        const receipt = await cell.spawnRuntime(
          {
            runtimeInstanceId: instance.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Survive the daemon upgrade",
            taskId: null,
            dispatchKey: "resident-readopt",
          },
          withPolicyGroup(
            { actor: { principal: { personId: "resident-worker" }, executor: null }, source: "local" },
            "admin",
          ),
        );
        writeFileSync(`${config.sessionFile}.tmp`, JSON.stringify(receipt));
        renameSync(`${config.sessionFile}.tmp`, config.sessionFile);
      }
      if ((config.failDrain || config.failDeadline) && readFileSync(config.marker, "utf8").trim() === "build-a") {
        const close = cell.close.bind(cell);
        return Object.assign(Object.create(cell), {
          close: async () => {
            if (config.failDeadline) await new Promise<void>(() => {});
            if (!config.failBeforeCellClose) await close();
            throw new Error("injected resident drain failure");
          },
        });
      }
      return cell;
    };
  (globalThis as typeof globalThis & { residentFailureGate?: () => Promise<void> }).residentFailureGate = async () => {
    writeFileSync(config.failureEntered, "entered");
    while (!existsSync(config.failureRelease)) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  // Positive control: the old process cannot exit naturally after dropping the socket.
  if (readFileSync(config.marker, "utf8").trim() === "build-a") setInterval(() => {}, 1000);
}
