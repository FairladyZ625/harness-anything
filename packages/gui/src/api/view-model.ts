export type GuiViewId = "board" | "list" | "detail" | "doc-viewer" | "review-queue" | "graph";
export type GuiCoordinationStatus = "open" | "blocked" | "in_review" | "terminal" | "unknown";

export interface GuiTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly coordinationStatus: GuiCoordinationStatus;
  readonly closeoutReadiness: string;
}

export interface GuiBoardColumn {
  readonly id: GuiCoordinationStatus;
  readonly taskIds: readonly string[];
}

export interface GuiViewModel {
  readonly views: readonly GuiViewId[];
  readonly board: readonly GuiBoardColumn[];
  readonly list: readonly GuiTaskRow[];
  readonly reviewQueue: readonly GuiTaskRow[];
  readonly graph: {
    readonly nodes: readonly { readonly id: string; readonly title: string }[];
    readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: "child" | "related" }[];
  };
}

const viewOrder: readonly GuiViewId[] = ["board", "list", "detail", "doc-viewer", "review-queue", "graph"];
const boardOrder: readonly GuiCoordinationStatus[] = ["open", "blocked", "in_review", "terminal", "unknown"];

export function buildGuiViewModel(rows: readonly GuiTaskRow[]): GuiViewModel {
  const sortedRows = [...rows].sort((left, right) => left.taskId.localeCompare(right.taskId));
  return {
    views: viewOrder,
    board: boardOrder.map((status) => ({
      id: status,
      taskIds: sortedRows.filter((row) => row.coordinationStatus === status).map((row) => row.taskId)
    })),
    list: sortedRows,
    reviewQueue: sortedRows.filter((row) => row.closeoutReadiness === "ready"),
    graph: {
      nodes: sortedRows.map((row) => ({ id: row.taskId, title: row.title })),
      edges: []
    }
  };
}
