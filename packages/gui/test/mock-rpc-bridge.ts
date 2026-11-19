/** Route test doubles through the production wire entry while preserving each scenario's spy. */
export function mockRpcBridge<T extends object>(bridge: T, routes: Readonly<Record<string, keyof T & string>>): T {
  const handlers = bridge as Readonly<Record<string, unknown>>;
  return Object.assign(
    bridge,
    Object.hasOwn(handlers, "request")
      ? {}
      : {
          request(method: string, params: WireParams) {
            const handler = handlers[routes[method] ?? method];
            if (typeof handler !== "function") throw new Error(`Unexpected RPC in fixture: ${method}`);
            return handler(fixtureRpcPayload(params));
          },
        },
    Object.hasOwn(handlers, "attachTerminal") && typeof handlers.attachTerminal === "function"
      ? {
          subscribe(method: string, params: WireParams, onValue: (value: unknown) => void) {
            if (method !== "repo.terminal.attach") return () => undefined;
            return (handlers.attachTerminal as (payload: unknown, receive: typeof onValue) => () => void)(
              fixtureRpcPayload(params),
              onValue,
            );
          },
        }
      : {},
  );
}
type WireParams = { readonly repo?: { readonly repoId: string }; readonly payload?: object };
function fixtureRpcPayload({ repo, payload }: WireParams): object {
  return repo ? { repoId: repo.repoId, ...payload } : (payload ?? {});
}
