import path from "node:path";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { relocateFleetCenter } from "@harness-anything/daemon/internal/fleet/center";
import { daemonOption } from "./control-support.ts";

type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;

export async function runFleetCenterRelocationControl(
  argv: readonly string[],
  userRoot: string,
  finish: ControlFinisher,
): Promise<number> {
  const outcome = await relocateFleetCenter(argv, userRoot);
  return finish(outcome.receipt, outcome.exitCode);
}

/**
 * The center-start payload, or the receipt fields that refuse the shape. The TLS certificate
 * pair is together-or-neither: an omitted pair makes the daemon reuse the login service
 * listener certificate, which is the only source a human user can be expected to have; half a
 * pair is a caller mistake and is refused here, before a transport is opened.
 */
export function fleetCenterStartPayload(
  argv: readonly string[],
): { readonly payload: JsonObject } | { readonly code: string; readonly nextAction: string } {
  const flag = (name: string) => daemonOption(argv, name),
    key = flag("--key"),
    cert = flag("--cert");
  if ((key === undefined) !== (cert === undefined))
    return {
      code: "invalid_field",
      nextAction: "Pass --key and --cert together, or neither to reuse the login service certificate.",
    };
  return {
    payload: {
      port: Number(flag("--port")),
      ...(key === undefined ? {} : { keyPath: path.resolve(key), certPath: path.resolve(cert!) }),
      repoId: flag("--repo"),
      quotaBytes: Number(flag("--quota-bytes")),
      ...(flag("--bind") ? { bind: flag("--bind") } : {}),
      ...(flag("--external-url") ? { externalUrl: flag("--external-url") } : {}),
      ...(flag("--state-root") ? { stateRoot: path.resolve(flag("--state-root")!) } : {}),
    } as JsonObject,
  };
}
