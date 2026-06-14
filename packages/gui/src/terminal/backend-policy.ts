import type { TerminalBackend, TerminalSessionInfo } from "./session-registry.ts";

export type TerminalBackendDurability = "none" | "daemon-restart" | "remote-owned";
export type TerminalBackendEvidence = "always-available" | "probe" | "not-installed" | "remote-owned" | "disabled";

export interface TerminalBackendCapability {
  readonly backend: TerminalBackend;
  readonly available: boolean;
  readonly durability: TerminalBackendDurability;
  readonly evidence: TerminalBackendEvidence;
  readonly version?: string;
  readonly reason?: string;
}

export interface TerminalBackendWarning {
  readonly code: "terminal_backend_downgraded_non_durable";
  readonly requestedBackend: TerminalBackend;
  readonly selectedBackend: TerminalBackend;
  readonly hint: string;
}

export interface TerminalBackendSelectionSuccess {
  readonly ok: true;
  readonly backend: TerminalBackend;
  readonly capability: TerminalBackendCapability;
  readonly durableAcrossDaemonRestart: boolean;
  readonly warnings: ReadonlyArray<TerminalBackendWarning>;
}

export interface TerminalBackendFailure {
  readonly ok: false;
  readonly error: {
    readonly code:
      | "terminal_backend_mismatch"
      | "terminal_backend_unavailable"
      | "terminal_backend_not_registered"
      | "terminal_backend_resource_closed";
    readonly hint: string;
  };
}

export type TerminalBackendSelectionResult = TerminalBackendSelectionSuccess | TerminalBackendFailure;

export interface SelectTerminalBackendInput {
  readonly requestedBackend?: TerminalBackend;
  readonly defaultBackend?: TerminalBackend;
  readonly capabilities: ReadonlyArray<TerminalBackendCapability>;
  readonly allowDirectPtyFallback?: boolean;
}

export interface TerminalBackendNamespaceInput {
  readonly sessionId: string;
  readonly hostProfileId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly cwd?: string;
}

export interface TerminalBackendNamespace {
  readonly namespace: string;
  readonly material: string;
}

export type TerminalBackendResourceStatus = "attached" | "detached" | "closed";

export interface TerminalBackendResource {
  readonly resourceId: string;
  readonly sessionId: string;
  readonly backend: TerminalBackend;
  readonly namespace: string;
  readonly durability: TerminalBackendDurability;
  readonly status: TerminalBackendResourceStatus;
  readonly closeReason?: string;
}

export interface TerminalBackendResourceInput {
  readonly session: TerminalSessionInfo;
  readonly selection: TerminalBackendSelectionSuccess;
  readonly namespace: TerminalBackendNamespace;
}

export interface TerminalBackendResourceSuccess {
  readonly ok: true;
  readonly resource: TerminalBackendResource;
}

export type TerminalBackendResourceResult = TerminalBackendResourceSuccess | TerminalBackendFailure;

export interface InMemoryTerminalBackendController {
  readonly createResource: (input: TerminalBackendResourceInput) => TerminalBackendResourceResult;
  readonly detachResourceView: (sessionId: string) => TerminalBackendResourceResult;
  readonly resumeResource: (sessionId: string) => TerminalBackendResourceResult;
  readonly closeResource: (sessionId: string) => TerminalBackendResourceResult;
  readonly simulateDaemonRestart: () => void;
  readonly listResources: () => ReadonlyArray<TerminalBackendResource>;
}

export function directPtyCapability(): TerminalBackendCapability {
  return {
    backend: "direct-pty",
    available: true,
    durability: "none",
    evidence: "always-available",
    reason: "direct-pty sessions are development/degrade sessions and do not survive daemon restart."
  };
}

export function tmuxCapability(input: { readonly available: boolean; readonly version?: string; readonly reason?: string }): TerminalBackendCapability {
  return {
    backend: "tmux",
    available: input.available,
    durability: "daemon-restart",
    evidence: input.available ? "probe" : "not-installed",
    version: input.version,
    reason: input.reason
  };
}

export function remoteCapability(input: { readonly available: boolean; readonly reason?: string }): TerminalBackendCapability {
  return {
    backend: "remote",
    available: input.available,
    durability: "remote-owned",
    evidence: input.available ? "remote-owned" : "disabled",
    reason: input.reason
  };
}

export function selectTerminalBackend(input: SelectTerminalBackendInput): TerminalBackendSelectionResult {
  const targetBackend = input.requestedBackend ?? input.defaultBackend ?? "direct-pty";
  const target = findCapability(input.capabilities, targetBackend);
  if (!target) return backendFailure("terminal_backend_not_registered", `Terminal backend is not registered: ${targetBackend}`);
  if (target.available) return backendSelection(target, []);
  if (targetBackend === "tmux" && input.allowDirectPtyFallback !== false) {
    const fallback = findCapability(input.capabilities, "direct-pty");
    if (fallback?.available) {
      return backendSelection(fallback, [
        {
          code: "terminal_backend_downgraded_non_durable",
          requestedBackend: "tmux",
          selectedBackend: "direct-pty",
          hint: target.reason ?? "tmux is unavailable; selected direct-pty. This session will not survive daemon restart."
        }
      ]);
    }
  }
  return backendFailure("terminal_backend_unavailable", target.reason ?? `Terminal backend is unavailable: ${targetBackend}`);
}

export function createTerminalBackendNamespace(input: TerminalBackendNamespaceInput): TerminalBackendNamespace {
  const material = [
    `host=${input.hostProfileId ?? "local"}`,
    `project=${input.projectId ?? "none"}`,
    `task=${input.taskId ?? "none"}`,
    `cwd=${input.cwd ?? "none"}`,
    `session=${input.sessionId}`
  ].join("|");
  return {
    namespace: `ha-${stableHash(material)}-${sanitizeNamespacePart(input.sessionId)}`,
    material
  };
}

export function createInMemoryTerminalBackendController(): InMemoryTerminalBackendController {
  const resources = new Map<string, TerminalBackendResource>();

  function save(resource: TerminalBackendResource): TerminalBackendResource {
    resources.set(resource.sessionId, resource);
    return resource;
  }

  function existing(sessionId: string): TerminalBackendResourceResult {
    const resource = resources.get(sessionId);
    if (!resource) return backendFailure("terminal_backend_unavailable", `No backend resource exists for terminal session: ${sessionId}`);
    if (resource.status === "closed") {
      return backendFailure("terminal_backend_resource_closed", resource.closeReason ?? "Terminal backend resource is closed.");
    }
    return { ok: true, resource };
  }

  return {
    createResource: (input) => {
      if (input.session.backend !== input.selection.backend) {
        return backendFailure(
          "terminal_backend_mismatch",
          `Terminal session backend ${input.session.backend} does not match selected backend ${input.selection.backend}.`
        );
      }
      const resource: TerminalBackendResource = {
        resourceId: `${input.namespace.namespace}:${input.session.sessionId}`,
        sessionId: input.session.sessionId,
        backend: input.selection.backend,
        namespace: input.namespace.namespace,
        durability: input.selection.capability.durability,
        status: "attached"
      };
      return { ok: true, resource: save(resource) };
    },
    detachResourceView: (sessionId) => {
      const resource = existing(sessionId);
      if (!resource.ok) return resource;
      return { ok: true, resource: save({ ...resource.resource, status: "detached" }) };
    },
    resumeResource: (sessionId) => {
      const resource = existing(sessionId);
      if (!resource.ok) return resource;
      return { ok: true, resource: save({ ...resource.resource, status: "attached" }) };
    },
    closeResource: (sessionId) => {
      const resource = resources.get(sessionId);
      if (!resource) return backendFailure("terminal_backend_unavailable", `No backend resource exists for terminal session: ${sessionId}`);
      return { ok: true, resource: save({ ...resource, status: "closed", closeReason: "explicit-close" }) };
    },
    simulateDaemonRestart: () => {
      for (const resource of resources.values()) {
        if (resource.status === "closed") continue;
        if (resource.durability === "none") {
          save({ ...resource, status: "closed", closeReason: "daemon-restart-non-durable-backend" });
        } else {
          save({ ...resource, status: "detached" });
        }
      }
    },
    listResources: () => [...resources.values()].sort((left, right) => left.resourceId.localeCompare(right.resourceId))
  };
}

function backendSelection(capability: TerminalBackendCapability, warnings: ReadonlyArray<TerminalBackendWarning>): TerminalBackendSelectionSuccess {
  return {
    ok: true,
    backend: capability.backend,
    capability,
    durableAcrossDaemonRestart: capability.durability !== "none",
    warnings
  };
}

function backendFailure(code: TerminalBackendFailure["error"]["code"], hint: string): TerminalBackendFailure {
  return { ok: false, error: { code, hint } };
}

function findCapability(capabilities: ReadonlyArray<TerminalBackendCapability>, backend: TerminalBackend): TerminalBackendCapability | undefined {
  return capabilities.find((capability) => capability.backend === backend);
}

function sanitizeNamespacePart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "terminal";
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
