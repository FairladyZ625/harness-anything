import type { HostingCredentialRefs, RuntimeInstanceConfig } from "./agent-runtime-instance-types.ts";
import type { HostingProviderKind } from "./hosting-provider.ts";

/** One lookup for publication and readiness. An unscoped disk ref never grants repository access. */
export function hostingCredentialReference(
  instance: { readonly hostingCredentialRefsByRepo?: Readonly<Record<string, HostingCredentialRefs>> },
  provider: HostingProviderKind,
  repoId: string,
): string | undefined {
  return Object.hasOwn(instance.hostingCredentialRefsByRepo ?? {}, repoId)
    ? instance.hostingCredentialRefsByRepo![repoId]?.[provider]
    : undefined;
}

/** Vault retirement must preserve refs used by any repository, including previous-version disk residue. */
export function runtimeInstanceUsesCredential(config: RuntimeInstanceConfig, reference: string): boolean {
  return (
    (config.auth.mode === "api-key" && config.auth.credentialRef === reference) ||
    Object.values(config.hostingCredentialRefs ?? {}).includes(reference) ||
    Object.values(config.hostingCredentialRefsByRepo ?? {}).some((refs) => Object.values(refs).includes(reference))
  );
}
