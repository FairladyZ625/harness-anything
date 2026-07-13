/** @slice-activation GUI workspace shell contract: exported for renderer model tests and package-level shell consumers. */
import { t } from "./i18n/core.ts";

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
  readonly id: "workspace" | "board" | "list" | "detail" | "doc-viewer" | "review-queue" | "graph";
  readonly label: string;
}

export const rendererNavigation: readonly RendererNavigationItem[] = [
  { id: "workspace", get label() { return t("renderer.appModel.workspace"); } },
  { id: "board", get label() { return t("renderer.appModel.board"); } },
  { id: "list", get label() { return t("renderer.appModel.list"); } },
  { id: "detail", get label() { return t("renderer.appModel.detail"); } },
  { id: "doc-viewer", get label() { return t("renderer.appModel.docs"); } },
  { id: "review-queue", get label() { return t("renderer.appModel.review"); } },
  { id: "graph", get label() { return t("renderer.appModel.graph"); } }
];
