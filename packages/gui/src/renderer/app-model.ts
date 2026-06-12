export interface RendererCapabilityModel {
  readonly nodeGlobalsAvailable: false;
  readonly privilegedModulesAvailable: false;
  readonly receivesOnlyPreloadData: true;
}

export const rendererCapabilityModel: RendererCapabilityModel = {
  nodeGlobalsAvailable: false,
  privilegedModulesAvailable: false,
  receivesOnlyPreloadData: true
};

export interface RendererNavigationItem {
  readonly id: "board" | "list" | "detail" | "doc-viewer" | "review-queue" | "graph";
  readonly label: string;
}

export const rendererNavigation: readonly RendererNavigationItem[] = [
  { id: "board", label: "Board" },
  { id: "list", label: "List" },
  { id: "detail", label: "Detail" },
  { id: "doc-viewer", label: "Docs" },
  { id: "review-queue", label: "Review" },
  { id: "graph", label: "Graph" }
];
