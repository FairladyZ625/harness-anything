import type { StatusTone } from "../components/primitives/StatusTag.tsx";
import type { MessageKey } from "../i18n/index.tsx";

/**
 * 仓库 cellState 的统一呈现口径(标准 §3:同一状态同一颜色的有底色标签):
 * HomeView 的目录行与 SystemView 的仓库表共用这一份映射,不在两页各写一套状态色。
 */
const CELL_STATE: Record<string, { readonly tone: StatusTone; readonly labelKey: MessageKey }> = {
  warming: { tone: "wait", labelKey: "views.systemView.stateWarming" },
  attached: { tone: "done", labelKey: "views.systemView.stateAttached" },
  unavailable: { tone: "bad", labelKey: "views.systemView.stateUnavailable" },
  not_loaded: { tone: "neutral", labelKey: "views.systemView.stateNotLoaded" },
};

export function repoCellMeta(cellState: string): { readonly tone: StatusTone; readonly labelKey: MessageKey } {
  return CELL_STATE[cellState] ?? { tone: "neutral", labelKey: "views.systemView.stateNotLoaded" };
}

/** 异常态判定:不可用或带错误信息的仓在目录里置顶并用红竖线强调(标准 §2.5)。 */
export function repoNeedsAttention(repo: {
  readonly cellState: string;
  readonly unavailableReason: string | null;
  readonly lastError: string | null;
}): boolean {
  return repo.cellState === "unavailable" || repo.unavailableReason !== null || repo.lastError !== null;
}
