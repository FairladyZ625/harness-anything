/**
 * Whether this machine can point an invitation at a login service the invited person can open.
 *
 * The read is `harness:center:settings` → `listener`. `listener: null` means no login listener
 * certificate has been configured, and `rbac_not_configured` means there is no login service at
 * all. In both cases an invitation would carry a sign-in address nobody else can use, so the entry
 * says what is missing instead of rendering a form that cannot produce a working link.
 *
 * Only those two definite answers block. Any other failure is not evidence about the prerequisite,
 * so it resolves to `ready`: the form stays usable and the daemon's own refusal names the real
 * problem rather than a second guess hiding the entry.
 */
export type CenterReadiness =
  | { readonly state: "ready" }
  | { readonly state: "missing"; readonly reason: "certificate-unconfigured" | "login-unconfigured" };

export function centerReadiness(reply: unknown): CenterReadiness {
  if (
    typeof reply === "object" &&
    reply !== null &&
    (reply as { readonly ok?: unknown }).ok === false &&
    (reply as { readonly code?: unknown }).code === "rbac_not_configured"
  )
    return { state: "missing", reason: "login-unconfigured" };
  const listener =
    typeof reply === "object" && reply !== null && "listener" in reply
      ? (reply as { readonly listener?: unknown }).listener
      : undefined;
  return listener === null ? { state: "missing", reason: "certificate-unconfigured" } : { state: "ready" };
}
