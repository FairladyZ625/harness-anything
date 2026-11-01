import { actionDeclarations } from "@harness-anything/kernel";
import {
  hostAdminCommandTopology,
  nodeLocalWriteCommandTopology,
  repoReadCommandTopology,
  type CommandTopology,
} from "@harness-anything/preset/internal/preset-command-contract";
import { allDaemonProtocolMethods, daemonProtocolCommands } from "./protocol/daemon-protocol-commands.ts";
import { daemonGuiReadMethods } from "./protocol/daemon-protocol-gui-reads.ts";
import { daemonGuiActionMethods, daemonStreamFacets } from "./protocol/daemon-protocol-gui-actions.ts";
import { daemonRepoModeWords } from "./protocol/daemon-protocol-vocabulary.ts";

type RpcDeclaration = {
  readonly id: string;
  readonly method: string;
  readonly actionKind?: string;
  readonly commandClass?: string;
  readonly admission?: CommandTopology["admission"];
};
type CommandDeclaration = CommandTopology & {
  readonly id: string;
  readonly method: string;
  readonly actionKind?: string;
};
export interface RpcRoutingDeclaration {
  readonly id: string;
  readonly method: string;
  readonly actionKind: string | null;
  readonly scope: "command-routing" | "read-admission-only";
  readonly topology: CommandTopology;
}

// These host controls have no CLI action declaration. This is their ownership port,
// consumed by protocol startup as well as the coverage gate; unknown methods have no default.
const hostMethodTopology: ReadonlyMap<string, CommandTopology> = new Map([
  ["daemon.skillEval.case.add", hostAdminCommandTopology],
  ["daemon.skillEval.cases.list", repoReadCommandTopology],
  ["daemon.skillEval.run", hostAdminCommandTopology],
  ["daemon.fleet.center.read", repoReadCommandTopology],
  ["daemon.fleet.center.external-address.read", repoReadCommandTopology],
  ["daemon.fleet.center.external-address.set", hostAdminCommandTopology],
  // Transport coordinators execute locally; their nested actions retain the command routes above.
  ["daemon.fleet.task.run", hostAdminCommandTopology],
  ["daemon.fleet.doc.sync", hostAdminCommandTopology],
  ["daemon.fleet.conflict.exit", hostAdminCommandTopology],
  ["repo.agentRuntime.attach", repoReadCommandTopology],
]);
// Read authorization admission is recorded here; replica/center/runtime read residency remains
// owned by the existing read port. A new method cannot opt in merely by claiming repo-read.
const readMethods = new Set<string>(
  [...daemonGuiReadMethods, ...daemonGuiActionMethods, ...daemonStreamFacets]
    .filter((method) => "commandClass" in method && method.commandClass === "repo-read")
    .map((method) => method.method),
);
const localActions = new Map(actionDeclarations.map((action) => [action.kind, action]));
function missing(method: string): never {
  throw Object.assign(new Error(`RPC ${method} has no declared repository/node route.`), { code: "rpc_route_missing" });
}

export function daemonRpcRoutingDeclarations(
  methods: readonly RpcDeclaration[] = allDaemonProtocolMethods,
  commands: readonly CommandDeclaration[] = daemonProtocolCommands,
): readonly RpcRoutingDeclaration[] {
  const byAction = new Map([...commands].reverse().map((command) => [command.actionKind ?? command.id, command]));
  return methods.flatMap((method) => {
    // The generic methods are discriminated by payload.action.kind, never last-method-wins.
    const candidates =
      method.method === "repo.task.run" || method.method === "repo.task.read"
        ? commands.filter((command) => command.method === method.method)
        : method.actionKind
          ? [byAction.get(method.actionKind)].filter((command): command is CommandDeclaration => command !== undefined)
          : commands.filter((command) => command.method === method.method);
    if (candidates.length)
      return candidates.map((command) => ({
        id: method.id,
        method: method.method,
        actionKind: command.actionKind ?? command.id,
        scope: command.commandClass === "repo-read" ? ("read-admission-only" as const) : ("command-routing" as const),
        topology: command,
      }));
    const action = method.actionKind ? localActions.get(method.actionKind) : undefined;
    const topology =
      method.admission && method.commandClass
        ? (method as CommandTopology)
        : action?.residency.scope === "runtime-local" && action.executionClass === "repo-write"
          ? nodeLocalWriteCommandTopology
          : action?.residency.scope === "host-local" && action.executionClass === "admin"
            ? hostAdminCommandTopology
            : method.commandClass === "repo-read" && readMethods.has(method.method)
              ? repoReadCommandTopology
              : hostMethodTopology.get(method.method);
    if (!topology) missing(method.method);
    return [
      {
        id: method.id,
        method: method.method,
        actionKind: method.actionKind ?? null,
        scope: topology.commandClass === "repo-read" ? ("read-admission-only" as const) : ("command-routing" as const),
        topology,
      },
    ];
  });
}

export function assertDaemonRpcRouting(
  routes: readonly RpcRoutingDeclaration[],
  methods: readonly RpcDeclaration[] = allDaemonProtocolMethods,
): void {
  const expected = daemonRpcRoutingDeclarations(methods);
  const key = (route: RpcRoutingDeclaration) => JSON.stringify([route.method, route.id, route.actionKind]);
  const keys = new Set([...expected, ...routes].map(key));
  for (const identity of keys) {
    const canonical = expected.filter((route) => key(route) === identity);
    const actual = routes.filter((route) => key(route) === identity);
    const method = canonical[0]?.method ?? actual[0]!.method;
    if (canonical.length !== actual.length) missing(method);
    for (const route of actual)
      if (
        route.scope !== canonical[0]!.scope ||
        route.topology.commandClass !== canonical[0]!.topology.commandClass ||
        daemonRepoModeWords.some((mode) => route.topology.admission[mode] !== canonical[0]!.topology.admission[mode])
      )
        missing(method);
  }
  const names = new Set(methods.map((method) => method.method));
  if (routes.some((route) => !names.has(route.method))) throw new Error("RPC routing contains an undeclared method.");
  for (const method of methods) {
    const aliases = routes.filter((route) => route.method === method.method && route.id === method.id);
    if (!aliases.length) missing(method.method);
    for (const route of aliases) {
      const modes = Object.keys(route.topology.admission).sort();
      if (JSON.stringify(modes) !== JSON.stringify([...daemonRepoModeWords].sort())) missing(method.method);
      for (const mode of daemonRepoModeWords)
        if (
          !["direct", "via-node", "via-center-forward", "edge-replica", "rejected"].includes(
            route.topology.admission[mode],
          )
        )
          missing(method.method);
    }
  }
}

const registeredRoutes = daemonRpcRoutingDeclarations();
assertDaemonRpcRouting(registeredRoutes);

/** A dedicated host entrance can consume a single route; payload-discriminated methods cannot. */
export function daemonRpcCommandTopology(method: string): CommandTopology {
  const routes = registeredRoutes.filter((route) => route.method === method);
  const topology = routes[0]?.topology;
  if (
    !topology ||
    routes.some((route) => JSON.stringify(route.topology.admission) !== JSON.stringify(topology.admission))
  )
    missing(method);
  return topology;
}
