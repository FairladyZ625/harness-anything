import type { RemoteReadDownSessionHealth } from "./remote-read-down-contract.ts";
import type { BrokerDurableState } from "./types.ts";

export type RemoteBrokerRuntimeLifecycle = "IDLE" | "STARTING" | "ACTIVE" | "STOPPED";

export type RemoteBrokerRuntimeHealth =
  | { readonly status: "IDLE" | "STARTING" | "RECOVERING" | "RUNNING" | "STOPPED" }
  | { readonly status: "TERMINAL"; readonly failure: Error };

export function deriveRemoteBrokerRuntimeHealth(input: {
  readonly lifecycle: RemoteBrokerRuntimeLifecycle;
  readonly durable: BrokerDurableState | undefined;
  readonly session: RemoteReadDownSessionHealth | undefined;
  readonly hasPendingWork: boolean;
  readonly failure: Error | undefined;
}): RemoteBrokerRuntimeHealth {
  if (input.failure) return { status: "TERMINAL", failure: input.failure };
  if (input.session?.status === "TERMINAL") {
    return { status: "TERMINAL", failure: input.session.failure };
  }
  if (input.lifecycle === "STOPPED") return { status: "STOPPED" };
  if (input.lifecycle === "IDLE") return { status: "IDLE" };
  if (input.lifecycle === "STARTING") return { status: "STARTING" };
  if (!input.durable
    || input.durable.mode !== "READY"
    || input.session?.status !== "READY"
    || input.hasPendingWork) {
    return { status: "RECOVERING" };
  }
  return { status: "RUNNING" };
}
