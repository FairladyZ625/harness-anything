import {
  parseAgentRuntimeInventory,
  parseRuntimeInstallation,
  parseRuntimeKind,
  parseRuntimeSession,
  runtimeKindRegistry,
  type AgentRuntimeInventory,
  type RuntimeDiscoverySource,
  type RuntimeCapability,
  type RuntimeInstallation,
  type RuntimeInstallationStates,
  type RuntimeKind,
  type RuntimeRunningEvidence,
  type RuntimeSession,
  type RuntimeStateEvidence
} from "@harness-anything/kernel";
import type {
  AgentRuntimeInventoryProjection,
  AgentRuntimeStateProjection
} from "./index.ts";
import { executableProbeEvidence } from "./agent-runtime-evidence.ts";

export interface RuntimeExecutableCandidate {
  readonly kindId: string;
  readonly executablePath: string;
  readonly source: RuntimeDiscoverySource;
}

export interface RuntimeExecutableVerification {
  readonly executable: boolean;
  readonly version?: string;
}

export interface AgentRuntimeDiscoveryProbe {
  readonly environmentOverride: (kind: RuntimeKind) => Promise<RuntimeExecutableCandidate | undefined>;
  readonly path: (kind: RuntimeKind) => Promise<RuntimeExecutableCandidate | undefined>;
  readonly loginShell: (kinds: ReadonlyArray<RuntimeKind>) => Promise<ReadonlyArray<RuntimeExecutableCandidate>>;
  readonly appBundle: (kind: RuntimeKind) => Promise<RuntimeExecutableCandidate | undefined>;
  readonly verify: (candidate: RuntimeExecutableCandidate) => Promise<RuntimeExecutableVerification>;
}

export type RuntimeInstallationAssessment = Pick<RuntimeInstallationStates, "authenticated" | "running" | "attachable">;

export interface AgentRuntimeServiceOptions {
  readonly discovery: AgentRuntimeDiscoveryProbe;
  readonly kinds?: ReadonlyArray<RuntimeKind>;
  readonly assessInstallation?: (installation: RuntimeInstallation) => Promise<RuntimeInstallationAssessment>;
  readonly listSessions?: () => Promise<ReadonlyArray<RuntimeSession>>;
  readonly now?: () => string;
  readonly loginShellTimeoutMs?: number;
}

export interface AgentRuntimeService {
  readonly inventory: () => Promise<AgentRuntimeInventory>;
  readonly inventoryProjection: () => Promise<AgentRuntimeInventoryProjection>;
}

const safeReasonCodes = new Set([
  "attach-channel-available",
  "attach-channel-unavailable",
  "attach-channel-not-probed",
  "attach-channel-probe-failed",
  "authentication-not-probed",
  "authentication-probe-failed",
  "authentication-unverified",
  "discovery-not-run",
  "discovery-probe-failed",
  "executable-not-verified",
  "executable-verified",
  "process-alive",
  "process-exited",
  "process-not-found",
  "process-witness-unavailable",
  "profile-authenticated",
  "profile-invalid",
  "profile-not-authenticated"
]);

export function makeAgentRuntimeService(options: AgentRuntimeServiceOptions): AgentRuntimeService {
  const kinds = (options.kinds ?? runtimeKindRegistry).map(parseRuntimeKind);
  const now = options.now ?? (() => new Date().toISOString());
  const inventory = async (): Promise<AgentRuntimeInventory> => {
    const generatedAt = now();
    const discovered = await discoverRuntimeInstallations(kinds, options.discovery, options.loginShellTimeoutMs ?? 1_500);
    const installations = await Promise.all(discovered.map(async (entry) => {
      const base = parseRuntimeInstallation(installationFromCandidate(entry.candidate, entry.verification, generatedAt));
      const assessment = await options.assessInstallation?.(base) ?? unknownAssessment();
      return { ...base, states: { ...base.states, ...assessment } };
    }));
    return parseAgentRuntimeInventory({
      schema: "agent-runtime-inventory/v1",
      generatedAt,
      kinds,
      installations,
      sessions: (await options.listSessions?.() ?? []).map(parseRuntimeSession)
    });
  };

  return {
    inventory,
    inventoryProjection: async () => projectAgentRuntimeInventory(await inventory())
  };
}

export async function discoverRuntimeInstallations(
  kinds: ReadonlyArray<RuntimeKind>,
  probe: AgentRuntimeDiscoveryProbe,
  loginShellTimeoutMs: number
): Promise<ReadonlyArray<{ readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>> {
  const found = new Map<string, { readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>();
  await discoverStage(kinds, probe.environmentOverride, probe, found);
  await discoverStage(unresolvedRuntimeKinds(kinds, found), probe.path, probe, found);

  const unresolvedBeforeShell = unresolvedRuntimeKinds(kinds, found);
  if (unresolvedBeforeShell.length > 0) {
    const candidates = await withTimeout(probe.loginShell(unresolvedBeforeShell), loginShellTimeoutMs, []);
    await acceptCandidates(candidates, probe, found, new Set(unresolvedBeforeShell.map(({ kindId }) => kindId)));
  }

  await discoverStage(unresolvedRuntimeKinds(kinds, found), probe.appBundle, probe, found);
  return kinds.flatMap((kind) => {
    const result = found.get(kind.kindId);
    return result ? [result] : [];
  });
}

export function projectAgentRuntimeInventory(inventory: AgentRuntimeInventory): AgentRuntimeInventoryProjection {
  return {
    ok: true,
    schema: "agent-runtime-inventory-projection/v1",
    generatedAt: inventory.generatedAt,
    rebuildable: true,
    kinds: inventory.kinds.map((kind) => ({
      kindId: kind.kindId,
      displayName: kind.displayName,
      protocolFamily: kind.protocolFamily,
      capabilities: kind.capabilities.map(projectCapability),
      authenticationProfileKinds: kind.authenticationProfiles.map(({ profileKind }) => profileKind)
    })),
    installations: inventory.installations.map((installation) => ({
      installationId: installation.installationId,
      kindId: installation.kindId,
      discoveredBy: installation.discoveredBy,
      ...(installation.version ? { version: installation.version } : {}),
      states: {
        installed: safeState(installation.states.installed),
        authenticated: safeState(installation.states.authenticated),
        running: safeState(installation.states.running),
        attachable: safeState(installation.states.attachable)
      }
    })),
    sessions: inventory.sessions.map((session) => ({
      runtimeSessionId: session.runtimeSessionId,
      kindId: session.kindId,
      installationId: session.installationId,
      ...projectProcessWitnessFields(session),
      running: safeState(processState(session)),
      attachable: safeState(session.attachable)
    }))
  };
}

function projectCapability({ name, state }: RuntimeCapability): AgentRuntimeInventoryProjection["kinds"][number]["capabilities"][number] {
  return { name, state };
}

async function discoverStage(
  kinds: ReadonlyArray<RuntimeKind>,
  discover: (kind: RuntimeKind) => Promise<RuntimeExecutableCandidate | undefined>,
  probe: AgentRuntimeDiscoveryProbe,
  found: Map<string, { readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>
): Promise<void> {
  const candidates = await Promise.all(kinds.map(async (kind) => {
    const candidate = await discover(kind);
    return candidate?.kindId === kind.kindId ? candidate : undefined;
  }));
  await acceptCandidates(candidates.filter((candidate): candidate is RuntimeExecutableCandidate => candidate !== undefined), probe, found);
}

async function acceptCandidates(
  candidates: ReadonlyArray<RuntimeExecutableCandidate>,
  probe: AgentRuntimeDiscoveryProbe,
  found: Map<string, { readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>,
  allowedKindIds?: ReadonlySet<string>
): Promise<void> {
  for (const candidate of candidates) {
    if (allowedKindIds && !allowedKindIds.has(candidate.kindId)) continue;
    if (found.has(candidate.kindId)) continue;
    const verification = await probe.verify(candidate);
    if (verification.executable) found.set(candidate.kindId, { candidate, verification });
  }
}

function unresolvedRuntimeKinds(kinds: ReadonlyArray<RuntimeKind>, found: ReadonlyMap<string, unknown>): ReadonlyArray<RuntimeKind> {
  return kinds.filter((kind) => !found.has(kind.kindId));
}

function installationFromCandidate(
  candidate: RuntimeExecutableCandidate,
  verification: RuntimeExecutableVerification,
  observedAt: string
): RuntimeInstallation {
  return {
    installationId: `local:${candidate.kindId}:${candidate.source}`,
    kindId: candidate.kindId,
    hostId: "local",
    executablePath: candidate.executablePath,
    ...(verification.version ? { version: verification.version } : {}),
    discoveredBy: candidate.source,
    states: {
      installed: {
        ...executableProbeEvidence({ source: candidate.source, executablePath: candidate.executablePath, executable: true, observedAt })
      },
      ...unknownAssessment()
    }
  };
}

function unknownAssessment(): RuntimeInstallationAssessment {
  return {
    authenticated: { criterion: "authentication-probe", state: "unknown", reason: "authentication-not-probed" },
    running: { criterion: "process-probe", state: "unknown", reason: "process-witness-unavailable" },
    attachable: { criterion: "attach-channel-probe", state: "unknown", reason: "attach-channel-not-probed" }
  };
}

function processState(session: RuntimeSession): RuntimeRunningEvidence {
  if (session.processWitness.state === "alive") return {
    criterion: "process-probe",
    state: true,
    reason: "process-alive",
    observedAt: session.processWitness.heartbeatAt ?? session.processWitness.startedAt,
    observation: { kind: "process-probe", outcome: "alive", runtimeSessionId: session.runtimeSessionId, pid: session.processWitness.pid }
  };
  if (session.processWitness.state === "exited") return {
    criterion: "process-probe",
    state: false,
    reason: "process-exited",
    observedAt: session.processWitness.exitedAt,
    observation: { kind: "process-probe", outcome: "exited", runtimeSessionId: session.runtimeSessionId, ...(session.processWitness.pid ? { pid: session.processWitness.pid } : {}) }
  };
  return { criterion: "process-probe", state: "unknown", reason: "process-witness-unavailable" };
}

function projectProcessWitnessFields(session: RuntimeSession): Pick<AgentRuntimeInventoryProjection["sessions"][number], "startedAt" | "lastHeartbeatAt" | "exitedAt" | "exitCode"> {
  const witness = session.processWitness;
  if (witness.state === "unknown") return {};
  return {
    ...(witness.startedAt ? { startedAt: witness.startedAt } : {}),
    ...(witness.heartbeatAt ? { lastHeartbeatAt: witness.heartbeatAt } : {}),
    ...(witness.state === "exited" ? { exitedAt: witness.exitedAt, ...(witness.exitCode !== undefined ? { exitCode: witness.exitCode } : {}) } : {})
  };
}

function safeState(evidence: RuntimeStateEvidence): AgentRuntimeStateProjection {
  return {
    criterion: evidence.criterion,
    state: evidence.state,
    reason: safeReasonCodes.has(evidence.reason) ? evidence.reason : "evidence-unavailable",
    ...(evidence.observedAt ? { observedAt: evidence.observedAt } : {})
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
