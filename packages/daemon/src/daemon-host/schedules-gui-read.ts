import type { CanonicalEventV1, DaemonRepoMode, TaskProjection } from "@harness-anything/kernel";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import type { InspectedScheduleProjection } from "@harness-anything/application/internal/queries/schedule-projection.ts";
import {
  deriveScheduleExecutionAvailability,
  readSchedulesGui as readApplicationSchedulesGui,
  scheduleActionFacet,
  type ScheduleGuiActionFacet,
  type ScheduleGuiActionKind,
  type SchedulesListResult,
} from "@harness-anything/application/internal/queries/schedules-gui-read.ts";
import type { AgentRuntimeInstanceDto } from "./agent-runtime-contract.ts";
import { readFleetEdgeConfig, type FleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { daemonUserRoot } from "./client/local-daemon-target.ts";
import { scheduleReasoningEfforts } from "./protocol/daemon-protocol-commands-runtime-fleet.ts";
import { commandDescriptorForAction } from "./protocol/daemon-protocol-commands.ts";
import { formatScheduleDuration } from "./protocol/daemon-protocol-vocabulary.ts";
import { defaultLedgerBackupRetention } from "./schedule-builtin-executor.ts";
import { admitRepoMode } from "./repo-mode.ts";
import { runtimeKindForId } from "../runtime-engine/runtime-inventory.ts";

export { deriveScheduleExecutionAvailability };

export interface SchedulesGuiReadContext {
  readonly mode: DaemonRepoMode | null;
  readonly rootDir: string;
  readonly userRoot?: string;
  readonly now: () => string;
  readonly input: {
    readonly repoId: string;
    readonly edgeConfig?: () => FleetEdgeConfig | null;
    readonly runtimeDaemonRoute?: { readonly userRoot: string };
    readonly runtimeInstances?: () => readonly AgentRuntimeInstanceDto[];
  };
  readonly projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch"> & {
    readonly listEntities: (entityKind: string) => readonly {
      readonly id?: string;
      readonly value: unknown;
      readonly workspaceRevision: number;
      readonly freshness?: "current" | "orphaned" | "unknown";
    }[];
    readonly readTaskStatuses: (taskIds?: readonly string[]) => {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
    readonly readScheduleEvents: () => {
      readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
      readonly events: readonly CanonicalEventV1[];
      readonly watermark: number;
      readonly sourceRevision: number;
    };
  };
}

function admissionFacet(actionKind: ScheduleGuiActionKind, mode: DaemonRepoMode): ScheduleGuiActionFacet {
  const command = commandDescriptorForAction(actionKind),
    admission = admitRepoMode(mode, command, "local"),
    available = admission.ok || (mode === "remote-edge" && command.admission[mode] === "via-center-forward");
  return scheduleActionFacet(available, available ? null : admission.code);
}

export function readSchedulesGui(
  context: SchedulesGuiReadContext,
  selected?: readonly InspectedScheduleProjection[],
): SchedulesListResult {
  return readApplicationSchedulesGui(
    {
      mode: context.mode,
      repoId: context.input.repoId,
      now: context.now,
      projection: context.projection,
      ports: {
        admitAction: admissionFacet,
        resolveEdgeNodeId: () => {
          const userRoot = context.userRoot ?? context.input.runtimeDaemonRoute?.userRoot ?? daemonUserRoot();
          const config = context.input.edgeConfig?.() ?? readFleetEdgeConfig(userRoot, context.input.repoId);
          if (!config) throw new Error("A remote-edge Schedule read requires fleet-edge.json.");
          return config.nodeId;
        },
        runtimeInstances: () =>
          (context.input.runtimeInstances?.() ?? [])
            .filter(({ enabled }) => enabled)
            .map((instance) => ({
              instanceId: instance.instanceId,
              name: instance.name,
              kindId: instance.kindId,
              models: instance.models,
              efforts:
                runtimeKindForId(instance.kindId).gui.effort === "free"
                  ? scheduleReasoningEfforts
                  : runtimeKindForId(instance.kindId).gui.effortValues,
            })),
        formatDuration: formatScheduleDuration,
        defaultBackupRetention: defaultLedgerBackupRetention,
      },
    },
    selected,
  );
}
