import { observeDaemonOperation } from "./daemon-operation.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

/** Fleet enters the same host APIs without JSON-RPC. Observe that boundary without changing TLS routing. */
export function observeFleetHostApi<T extends object>(api: T): T {
  return Object.fromEntries(
    Object.entries(api).map(([name, call]) => [
      name,
      typeof call !== "function"
        ? call
        : (...args: unknown[]) => {
            const auth = args.at(-1) as DaemonAuthenticationContext | undefined;
            if (auth?.transportKind !== "fleet-tls") return call(...args);
            const request = args[0] as { repoId?: string } | undefined,
              action = args[1] as { kind?: string } | undefined;
            return observeDaemonOperation(
              {
                method: typeof args[1] === "string" ? args[1] : (action?.kind ?? `host.${name}`),
                repoId: typeof args[0] === "string" ? args[0] : (request?.repoId ?? null),
                actor: auth.executionPrincipal?.personId ?? auth.nodePrincipal?.personId ?? null,
                phase: "host-dispatch",
              },
              () => call(...args),
            );
          },
    ]),
  ) as T;
}
