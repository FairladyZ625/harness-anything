import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

/** The local operator session the daemon resolves from its one OIDC session service. The writer
 * process receives it over the capability channel, which cannot carry the in-process token
 * refresher, so this contract intentionally stays data-only. */
export type RuntimeOperatorSession = Omit<
  NonNullable<NonNullable<RepoCellBinding["keycloakAuthorization"]>["session"]>,
  "currentAccessToken"
>;

/**
 * The only place a persisted local runtime binding regains its current authorization credentials.
 * `runtimeBindingForDispatch` deliberately drops transport fences and credentials before a
 * dispatch is persisted, so every continuation that replays one must re-read the daemon's
 * current operator session first. A device-scoped binding keeps its own verified session.
 */
export async function withOnlineRuntimeSession(
  binding: RepoCellBinding,
  readSession: () => Promise<RuntimeOperatorSession>,
  readCenter?: NonNullable<RepoCellBinding["keycloakAuthorization"]>["center"],
): Promise<RepoCellBinding> {
  if (binding.source !== "local") return binding;
  const session = await readSession();
  if (session.personId !== binding.actor.principal.personId)
    throw cellCodedError("authentication_required", "The original runtime owner must sign in on this device.");
  return {
    ...binding,
    keycloakAuthorization: {
      ...binding.keycloakAuthorization,
      session,
      ...(readCenter ? { center: readCenter } : {}),
    },
  };
}
