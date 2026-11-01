import {
  DEFAULT_NODE_AUTO_CLAIM_POLICY,
  readNodeAutoClaimDiagnostics,
  readNodeAutoClaimPolicy,
  writeNodeAutoClaimPolicy,
  type NodeAutoClaimPolicy,
} from "@harness-anything/daemon/internal/node-auto-claim-config";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";

export type NodeAutoClaimControl =
  | { readonly operation: "status" }
  | {
      readonly operation: "enable";
      readonly allowedAgentIds: readonly string[];
      readonly allowedSources: { readonly personIds: readonly string[]; readonly teamIds: readonly string[] };
      readonly maxConcurrent: number;
    }
  | { readonly operation: "disable" };

export function parseNodeAutoClaimControl(args: readonly string[]): NodeAutoClaimControl | string {
  const [operation, ...tokens] = args;
  if (operation !== "status" && operation !== "show" && operation !== "enable" && operation !== "disable")
    return "Use `ha daemon auto-claim status`, `enable`, or `disable`.";
  const values = new Map<string, string[]>(),
    flags = new Set(["--agent", "--allow-person", "--allow-team", "--max-concurrent"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--json") continue;
    if (["--user-root", "--daemon-id", "--root", "--repo"].includes(token)) {
      index += 1;
      if (!tokens[index]) return `${token} requires a value.`;
      continue;
    }
    if (!flags.has(token)) return `Unknown auto-claim option: ${token}.`;
    const value = tokens[++index];
    if (!value || value.startsWith("--")) return `${token} requires a value.`;
    if (token === "--max-concurrent" && (values.has(token) || !/^[1-9][0-9]*$/u.test(value)))
      return "--max-concurrent must be one integer from 1 to 64.";
    values.set(token, [...(values.get(token) ?? []), value]);
  }
  if (operation === "status" || operation === "show") {
    if (values.size) return "Status does not accept policy options.";
    return { operation: "status" };
  }
  if (operation === "disable") {
    if (values.size) return "Disable does not accept policy options.";
    return { operation: "disable" };
  }
  const allowedAgentIds = values.get("--agent") ?? [],
    maxConcurrent = Number(values.get("--max-concurrent")?.[0] ?? 1);
  if (allowedAgentIds.length === 0) return "Enable requires at least one --agent <id>.";
  if (maxConcurrent > 64) return "--max-concurrent must be one integer from 1 to 64.";
  return {
    operation: "enable",
    allowedAgentIds,
    allowedSources: {
      personIds: values.get("--allow-person") ?? [],
      teamIds: values.get("--allow-team") ?? [],
    },
    maxConcurrent,
  };
}

export async function applyNodeAutoClaimControl(
  control: NodeAutoClaimControl,
  userRoot: string,
  wake: () => Promise<boolean> = async () => false,
): Promise<JsonObject> {
  if (control.operation === "status") {
    const configured = readNodeAutoClaimPolicy(userRoot);
    return {
      ok: true,
      command: "daemon-auto-claim-status",
      policy: configured.policy as unknown as JsonObject,
      configuration: configured.diagnostic,
      ...(configured.error ? { configurationError: configured.error } : {}),
      recent: readNodeAutoClaimDiagnostics(userRoot).slice(-20) as unknown as JsonObject[],
    };
  }
  const policy: NodeAutoClaimPolicy =
    control.operation === "disable"
      ? DEFAULT_NODE_AUTO_CLAIM_POLICY
      : {
          schema: "node-auto-claim/v1",
          enabled: true,
          allowedSources: control.allowedSources,
          allowedAgentIds: control.allowedAgentIds,
          maxConcurrent: control.maxConcurrent,
        };
  writeNodeAutoClaimPolicy(userRoot, policy);
  const daemonAwake = await wake();
  return {
    ok: true,
    command: `daemon-auto-claim-${control.operation}`,
    policy: policy as unknown as JsonObject,
    activation: daemonAwake ? "woken" : "next-attach",
  };
}
