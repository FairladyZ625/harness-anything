import { requestDaemonJsonRpcAt } from "@harness-anything/daemon/internal/client/local-json-rpc-client";
import { resolveLocalDaemonTarget } from "@harness-anything/daemon/internal/client/local-daemon-target";
import type { DaemonGuiReadResultMap } from "@harness-anything/daemon/internal/protocol/daemon-protocol-gui-types";
import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { daemonOption } from "./control-support.ts";

// `ha daemon fleet status`: the center-side read of the whole fleet. It calls the same
// repo.fleet.overview.read the Collaboration page renders, so CLI and GUI share one read
// model — this module only lays the daemon's honest three-state fields out as text.
type FleetOverview = DaemonGuiReadResultMap["repo.fleet.overview.read"];
type FleetFieldState = FleetOverview["nodes"][number]["owner"];

export async function runDaemonFleetStatus(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
): Promise<JsonObject> {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--json" || !flag.startsWith("--")) continue;
    if (
      !["--root", "--repo", "--user-root", "--daemon-id"].includes(flag) ||
      !argv[index + 1] ||
      argv[index + 1]!.startsWith("--")
    )
      throw Object.assign(new Error(`Invalid fleet status option ${flag}; use ha daemon fleet status --help.`), {
        code: "invalid_field",
      });
    index += 1;
  }
  const target = await resolveLocalDaemonTarget({
    rootDir: daemonOption(argv, "--root") ?? process.cwd(),
    repoIdOverride: daemonOption(argv, "--repo"),
    userRoot,
    daemonId,
  });
  return requestDaemonJsonRpcAt(target.socketPath, "repo.fleet.overview.read", { repo: { repoId: target.repoId } }, 75);
}

export function renderDaemonFleetStatus(result: JsonObject): string {
  const overview = result as unknown as FleetOverview;
  const lines = [
    `fleet overview repo=${overview.repoId} mode=${overview.mode} generated=${overview.generatedAt}`,
    `center daemon=${overview.center.daemonId} version=${overview.center.version} commit=${overview.center.commitSha ?? "unknown"} started=${overview.center.startedAt} revision=${overview.centerRevision ?? "unavailable"}`,
  ];
  for (const node of overview.nodes) {
    lines.push("", `node ${node.nodeId} role=${node.role}`);
    lines.push(`  owner ${field(node.owner)}`);
    lines.push(
      `  ${node.role === "center" ? `daemon ${overview.center.daemonId} version=${overview.center.version} commit=${overview.center.commitSha ?? "unknown"}` : `build ${field(node.build)}`}`,
    );
    lines.push(
      node.role === "center"
        ? "  online running (center daemon process)"
        : // The heartbeat schedule (N2) is the only future online source; until it exists the
          // overview reports online as unavailable and this render says so instead of guessing.
          `  online heartbeat-not-integrated; online is never inferred from ACK or runtime (${node.online.kind === "value" ? node.online.text : node.online.reason})`,
    );
    if ("redacted" in node.leases) lines.push(`  doing leases redacted (${node.leases.redacted})`);
    else if (node.leases.length === 0) lines.push("  doing no task leases");
    else {
      lines.push(`  doing ${node.leases.length} lease(s)`);
      for (const lease of node.leases)
        lines.push(
          `    task ${lease.taskId} "${lease.title ?? "untitled"}" status=${lease.coordinationStatus}` +
            ` phase=${lease.phase ?? "unavailable"} person=${lease.personId ?? "unavailable"}` +
            `${lease.agentId === null ? "" : ` agent=${lease.agentLabel ?? lease.agentId}`}` +
            `${lease.runtimeSessionId === null ? "" : ` session=${lease.runtimeSessionId}`}` +
            `${lease.startedAt === null ? "" : ` started=${lease.startedAt}`}` +
            `${lease.dispatchStatus === null ? "" : ` dispatch=${lease.dispatchStatus}`}`,
        );
    }
    if (node.replica === null)
      lines.push(`  sync no replica row (${node.replicaNote ?? "center-replica-ledger-has-no-row-for-node"})`);
    else
      lines.push(
        `  sync view=${node.replica.viewId} ack=${node.replica.ackRevision ?? "never-acked"} center=${node.replica.centerRevision} lag=${node.replica.lagRevisions}rev` +
          ` ackedAt=${node.replica.ackedAt ?? "never"} delivery=${node.replica.delivery}`,
      );
    lines.push(`  watch ${field(node.watch)}`);
    lines.push(`  lastFailure ${field(node.lastFailure)}`);
  }
  lines.push("", `links ${overview.links.length}`);
  for (const link of overview.links)
    lines.push(
      `  ${link.nodeId} state=${link.state} lag=${link.lagRevisions}rev ackedAt=${link.ackedAt ?? "never"} centerRevision=${link.centerRevision}`,
    );
  lines.push("", `events ${overview.events.length} (window; attribution=current-lease)`);
  for (const event of overview.events.slice(0, 20))
    lines.push(
      `  ${event.occurredAt} rev=${event.workspaceRevision} ${event.type}${event.taskId === null ? "" : ` task=${event.taskId}`} -> ${event.nodeId}`,
    );
  if (overview.events.length > 20) lines.push(`  ... ${overview.events.length - 20} more`);
  if (overview.notes.length > 0) lines.push("", `notes ${overview.notes.join(" | ")}`);
  if (overview.warnings.length > 0) lines.push("", `warnings ${overview.warnings.join(" | ")}`);
  return lines.join("\n");
}

function field(state: FleetFieldState): string {
  if (state.kind === "value") return state.text;
  return state.kind === "redacted" ? `redacted (${state.reason})` : `unavailable (${state.reason})`;
}
