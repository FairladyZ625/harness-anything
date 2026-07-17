import {
  runtimeKindRegistry,
  type AgentRuntimeInventory,
  type RuntimeDiscoverySource,
  type RuntimeInstallation,
  type RuntimeKind,
  type RuntimeSession,
  type RuntimeStateEvidence
} from "../../kernel/src/index.ts";
import type {
  AgentRuntimeInventoryProjection,
  AgentRuntimeStateProjection
} from "./index.ts";

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

export interface RuntimeInstallationAssessment {
  readonly authenticated: RuntimeStateEvidence;
  readonly running: RuntimeStateEvidence;
  readonly attachable: RuntimeStateEvidence;
}

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
  "authentication-not-probed",
  "evidence-unavailable",
  "executable-verified",
  "process-alive",
  "process-exited",
  "process-witness-unavailable",
  "profile-authenticated",
  "profile-invalid",
  "profile-not-authenticated"
]);

export function makeAgentRuntimeService(options: AgentRuntimeServiceOptions): AgentRuntimeService {
  const kinds = options.kinds ?? runtimeKindRegistry;
  const now = options.now ?? (() => new Date().toISOString());
  const inventory = async (): Promise<AgentRuntimeInventory> => {
    const generatedAt = now();
    const discovered = await discoverRuntimeInstallations(kinds, options.discovery, options.loginShellTimeoutMs ?? 1_500);
    const installations = await Promise.all(discovered.map(async (entry) => {
      const base = installationFromCandidate(entry.candidate, entry.verification, generatedAt);
      const assessment = await options.assessInstallation?.(base) ?? unknownAssessment();
      return { ...base, states: { ...base.states, ...assessment } };
    }));
    return {
      schema: "agent-runtime-inventory/v1",
      generatedAt,
      kinds,
      installations,
      sessions: await options.listSessions?.() ?? []
    };
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
    await acceptCandidates(candidates, probe, found);
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
      capabilities: kind.capabilities.map(({ name, state }) => ({ name, state })),
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
      ...(session.processWitness.startedAt ? { startedAt: session.processWitness.startedAt } : {}),
      ...(session.processWitness.heartbeatAt ? { lastHeartbeatAt: session.processWitness.heartbeatAt } : {}),
      ...(session.processWitness.exitedAt ? { exitedAt: session.processWitness.exitedAt } : {}),
      ...(session.processWitness.exitCode !== undefined ? { exitCode: session.processWitness.exitCode } : {}),
      running: safeState(processState(session)),
      attachable: safeState(session.attachable)
    }))
  };
}

async function discoverStage(
  kinds: ReadonlyArray<RuntimeKind>,
  discover: (kind: RuntimeKind) => Promise<RuntimeExecutableCandidate | undefined>,
  probe: AgentRuntimeDiscoveryProbe,
  found: Map<string, { readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>
): Promise<void> {
  const candidates = await Promise.all(kinds.map(discover));
  await acceptCandidates(candidates.filter((candidate): candidate is RuntimeExecutableCandidate => candidate !== undefined), probe, found);
}

async function acceptCandidates(
  candidates: ReadonlyArray<RuntimeExecutableCandidate>,
  probe: AgentRuntimeDiscoveryProbe,
  found: Map<string, { readonly candidate: RuntimeExecutableCandidate; readonly verification: RuntimeExecutableVerification }>
): Promise<void> {
  for (const candidate of candidates) {
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
      installed: { state: true, reason: "executable-verified", observedAt },
      ...unknownAssessment()
    }
  };
}

function unknownAssessment(): RuntimeInstallationAssessment {
  return {
    authenticated: { state: "unknown", reason: "authentication-not-probed" },
    running: { state: "unknown", reason: "process-witness-unavailable" },
    attachable: { state: "unknown", reason: "evidence-unavailable" }
  };
}

function processState(session: RuntimeSession): RuntimeStateEvidence {
  if (session.processWitness.state === "alive") return { state: true, reason: "process-alive", observedAt: session.processWitness.heartbeatAt };
  if (session.processWitness.state === "exited") return { state: false, reason: "process-exited", observedAt: session.processWitness.exitedAt };
  return { state: "unknown", reason: "process-witness-unavailable" };
}

function safeState(evidence: RuntimeStateEvidence): AgentRuntimeStateProjection {
  return {
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
