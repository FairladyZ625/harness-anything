import { makeAgentRuntimeService } from "../../../application/src/index.ts";
import type { AgentRuntimeSessionStatus } from "../../../application/src/agent-runtime-control.ts";
import {
  createAgentRuntimeSessionService,
  createClaudeCodeRuntimeAdapter,
  createCodexRuntimeAdapter,
  type AgentRuntimeControlService
} from "../../../daemon/src/index.ts";
import type { RuntimeInstallation, RuntimeSession, RuntimeStateEvidence } from "../../../kernel/src/index.ts";
import { probeRuntimeAuthenticationProfiles } from "./agent-runtime-auth-profiles.ts";
import { createLocalAgentRuntimeDiscoveryProbe } from "./agent-runtime-host-discovery.ts";
import { createFileRuntimeSessionStore } from "./agent-runtime-session-store.ts";

export function createLocalAgentRuntimeControlHost(rootDir: string): {
  readonly control: AgentRuntimeControlService;
  readonly inventoryReader: ReturnType<typeof makeAgentRuntimeService>["inventoryProjection"];
} {
  const discovery = createLocalAgentRuntimeDiscoveryProbe();
  const baseInventory = makeAgentRuntimeService({ discovery });
  const executablePath = async (kindId: "claude-code" | "codex") => {
    const installation = (await baseInventory.inventory()).installations.find((candidate) => candidate.kindId === kindId);
    if (!installation) throw new Error(`${kindId} is not installed. Inspect 'ha agent profiles' and the runtime inventory.`);
    return installation.executablePath;
  };
  const control = createAgentRuntimeSessionService({
    adapters: [
      createClaudeCodeRuntimeAdapter({ executablePath: () => executablePath("claude-code") }),
      createCodexRuntimeAdapter({ executablePath: () => executablePath("codex") })
    ],
    store: createFileRuntimeSessionStore(rootDir),
    authProfiles: probeRuntimeAuthenticationProfiles,
    workspaceRoot: rootDir
  });
  const service = makeAgentRuntimeService({
    discovery,
    assessInstallation: async (installation) => assessInstallation(installation, control),
    listSessions: async () => runtimeSessions(await readStatuses(control), await baseInventory.inventory())
  });
  return { control, inventoryReader: service.inventoryProjection };
}

export function makeLocalAgentRuntimeControllerOptions(rootDir: string) {
  const host = createLocalAgentRuntimeControlHost(rootDir);
  return { agentRuntimeInventoryReader: host.inventoryReader, agentRuntimeControl: host.control };
}

async function assessInstallation(
  installation: RuntimeInstallation,
  control: AgentRuntimeControlService
) {
  const profileResult = await control.profiles();
  const profiles = profileResult.ok ? profileResult.profiles.filter((profile) => profile.kindId === installation.kindId) : [];
  const statuses = (await readStatuses(control)).filter((session) => session.kindId === installation.kindId);
  return {
    authenticated: profileEvidence(profiles.map((profile) => profile.state)),
    running: booleanEvidence(statuses.some((session) => session.process.state === "alive"), "process-alive", "process-witness-unavailable"),
    attachable: booleanEvidence(statuses.some((session) => session.attachable), "attach-channel-available", "attach-channel-unavailable")
  };
}

async function readStatuses(control: AgentRuntimeControlService): Promise<ReadonlyArray<AgentRuntimeSessionStatus>> {
  const result = await control.status();
  return result.ok ? result.sessions : [];
}

function runtimeSessions(
  statuses: ReadonlyArray<AgentRuntimeSessionStatus>,
  inventory: Awaited<ReturnType<ReturnType<typeof makeAgentRuntimeService>["inventory"]>>
): ReadonlyArray<RuntimeSession> {
  return statuses.flatMap((status) => {
    const installation = inventory.installations.find((candidate) => candidate.kindId === status.kindId);
    if (!installation) return [];
    return [{
      runtimeSessionId: status.runtimeSessionId,
      kindId: status.kindId,
      installationId: installation.installationId,
      ...(status.providerSessionId ? { providerSessionId: status.providerSessionId } : {}),
      processWitness: status.process,
      attachable: {
        state: status.attachable,
        reason: status.attachable ? "attach-channel-available" : "attach-channel-unavailable"
      },
      ...(status.clientBinding ? { clientBinding: status.clientBinding } : {})
    }];
  });
}

function profileEvidence(states: ReadonlyArray<string>): RuntimeStateEvidence {
  if (states.includes("configured")) return { state: true, reason: "profile-authenticated" };
  if (states.includes("invalid")) return { state: false, reason: "profile-invalid" };
  return { state: false, reason: "profile-not-authenticated" };
}

function booleanEvidence(state: boolean, whenTrue: string, whenFalse: string): RuntimeStateEvidence {
  return { state, reason: state ? whenTrue : whenFalse };
}
