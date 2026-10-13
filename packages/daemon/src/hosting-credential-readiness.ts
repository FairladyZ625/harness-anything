import {
  detectHostingProvider,
  hostingCredentialConfigurationAdvice,
  type HostingProviderKind,
} from "./hosting-provider.ts";
import type { DoctorCheck } from "./repo-cell-doctor.ts";

/**
 * Minimal structural view of a runtime instance row; the daemon host passes the real
 * instance store's configs, tests pass literals. Presence of a binding only — the
 * opaque reference itself never leaves this module.
 */
export interface HostingCredentialInstanceRow {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly hostingCredentialRefs?: Readonly<Partial<Record<HostingProviderKind, string>>>;
}

export interface HostingCredentialReaders {
  /** Enabled instance configs to inspect. */
  readonly instances: readonly HostingCredentialInstanceRow[];
}

interface HostingCredentialSnapshot {
  /** Provider identified for the repository's origin; null when origin names no GitHub/GitLab host. */
  readonly provider: HostingProviderKind | null;
  /** Enabled instance ids that bind the detected provider's credential. */
  readonly configuredInstanceIds: readonly string[];
}

async function hostingCredentialSnapshot(
  rootDir: string,
  instances: HostingCredentialReaders,
): Promise<HostingCredentialSnapshot> {
  const provider = await detectHostingProvider(rootDir, undefined, true);
  if (!provider) return { provider: null, configuredInstanceIds: [] };
  return {
    provider: provider.kind,
    configuredInstanceIds: instances.instances
      .filter((row) => row.enabled && row.hostingCredentialRefs?.[provider.kind] !== undefined)
      .map((row) => row.instanceId),
  };
}

/**
 * `ha doctor health` hosted-credential check. Runs in the daemon host process, where the
 * runtime instance store lives (the repo cell cannot see it); the host layer appends this
 * beside the build-drift check it already substitutes. Read-only: it reports binding
 * presence and names the configuration command, never resolving the secret from the vault.
 */
export async function hostedCredentialDoctorCheck(
  rootDir: string,
  instances: HostingCredentialReaders,
): Promise<DoctorCheck> {
  const id = "hosted-credential",
    { provider, configuredInstanceIds } = await hostingCredentialSnapshot(rootDir, instances);
  if (!provider)
    return {
      id,
      status: "indeterminate",
      summary:
        "Origin names no GitHub/GitLab host, so the daemon-held credential state for task push, PR, and CI cannot be judged.",
      count: 0,
      next: "Declare hosting.provider and hosting.host in the repository settings if this origin is GitHub or GitLab; otherwise nothing is owed.",
    };
  if (configuredInstanceIds.length > 0)
    return {
      id,
      status: "ok",
      summary: `${configuredInstanceIds.length} enabled runtime instance(s) bind a ${provider} hosting credential, so daemon-held task push, PR creation, and CI reads are available.`,
      count: configuredInstanceIds.length,
      next: "Nothing to do.",
    };
  return {
    id,
    status: "warn",
    summary: `No enabled runtime instance binds a ${provider} hosting credential; daemon-held task push, PR creation, and CI reads will fail with runtime_credential_unavailable.`,
    count: 0,
    next: `${hostingCredentialConfigurationAdvice(provider)}.`,
  };
}

/**
 * The operator notice a task-bound dispatch receipt carries when the repository has no
 * daemon-held hosting credential at all (no enabled instance binds the detected provider's
 * credential). Repo-level on purpose: instance selection happens at spawn time inside the
 * cell, and the per-instance gap already surfaces as runtime_credential_unavailable with
 * the same configuration sentence. Null when there is nothing to tell the operator.
 */
export async function hostingCredentialDispatchNotice(
  rootDir: string,
  instances: HostingCredentialReaders,
): Promise<string | null> {
  const { provider, configuredInstanceIds } = await hostingCredentialSnapshot(rootDir, instances);
  if (!provider || configuredInstanceIds.length > 0) return null;
  return `No enabled runtime instance binds a ${provider} hosting credential; the dispatched worker cannot publish its branch, open the task PR, or read CI until the operator configures one: ${hostingCredentialConfigurationAdvice(provider)}.`;
}

/**
 * Attach the operator notice to a task-bound spawn receipt. The receipt is returned as-is
 * for unbound dispatches (no publication owed) and for dry-run previews (a different
 * schema with no publication promise), and when the repository already has a credential
 * the notice is null and nothing changes.
 */
export async function annotateHostingCredentialNotice<T extends Record<string, unknown>>(
  receipt: T,
  payload: { readonly taskId?: unknown },
  rootDir: string,
  instances: HostingCredentialReaders,
): Promise<T> {
  if (typeof payload.taskId !== "string" || receipt.schema !== "command-receipt/v2") return receipt;
  const notice = await hostingCredentialDispatchNotice(rootDir, instances);
  if (notice === null) return receipt;
  const warnings = Array.isArray(receipt.warnings) ? receipt.warnings.filter((item) => typeof item === "string") : [];
  return { ...receipt, warnings: [...warnings, notice] };
}
