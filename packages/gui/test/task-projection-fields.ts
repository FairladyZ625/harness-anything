import type { SnapshotStatus, TaskCapabilityId, TaskRow } from "../src/renderer/model/types.ts";

/**
 * The board / visibility / capability fields the daemon projects onto every
 * `repo.tasks.list` row (dec_5B135F46 CH4 layer two). Column and rank follow
 * `taskBoardColumnOf` / `taskBoardRankOf` in the kernel's `task-board-projection.ts`,
 * which is the authority; fixtures restate the mapping here because those two are not
 * on the kernel's public barrel and tests may not deep-import kernel source.
 */
const COLUMN_OF: Record<SnapshotStatus, TaskRow["board"]["columnId"]> = {
  planned: "open",
  active: "open",
  blocked: "blocked",
  in_review: "in_review",
  done: "terminal",
  cancelled: "terminal",
  unknown: null,
};

const RANK_OF: Record<SnapshotStatus, number> = {
  blocked: 0,
  active: 1,
  in_review: 2,
  planned: 3,
  done: 4,
  cancelled: 5,
  unknown: 5,
};

const CAPABILITY_IDS: readonly TaskCapabilityId[] = ["start", "progress", "submit", "review", "complete"];

/**
 * Mirrors the kernel `taskPhase` judgment (task-board-projection.ts) for the same
 * reason as the column map above: tests may not deep-import kernel source.
 */
const PHASE_STEPS = ["planned", "active", "in_review", "done"] as const;
const PHASE_OF: Record<SnapshotStatus, { readonly index: number; readonly reason: string | null } | null> = {
  planned: { index: 0, reason: null },
  active: { index: 1, reason: null },
  in_review: { index: 2, reason: null },
  done: { index: 3, reason: null },
  blocked: { index: null, reason: "blocked_overlay" },
  cancelled: { index: null, reason: "terminal_cancelled" },
  unknown: { index: null, reason: "phase_unresolved" },
};

export function projectedTaskFields(
  status: SnapshotStatus,
  options: {
    readonly archived?: boolean;
    readonly can?: readonly TaskCapabilityId[];
    readonly risk?: boolean;
    readonly phase?: Pick<TaskRow["phase"], "index" | "reason">;
  } = {},
): Pick<TaskRow, "board" | "visibility" | "capabilities" | "risk" | "phase"> {
  const can = new Set(options.can ?? []);
  return {
    board: { columnId: COLUMN_OF[status], rank: RANK_OF[status] },
    visibility: { archived: options.archived === true, noise: options.archived === true || status === "cancelled" },
    capabilities: CAPABILITY_IDS.map((id) => ({
      id,
      available: can.has(id),
      reason: can.has(id) ? null : ("invalid_transition" as const),
    })),
    risk: { flagged: options.risk === true },
    phase: {
      steps: PHASE_STEPS,
      ...(PHASE_OF[status] ?? { index: null, reason: "phase_unresolved" }),
      ...options.phase,
    },
  };
}
