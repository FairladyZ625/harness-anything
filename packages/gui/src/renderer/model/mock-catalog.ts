import type { EventEntry } from "./types";
import { t } from "../i18n/core.ts";

export const MOCK_EVENTS: EventEntry[] = [
  { at: "2026-06-12T10:01:00", projectId: "harness-anything", taskId: "GUI-401", get summary() { return t("model.mockCatalog.additionalProgressThemeColorValueDualMode"); } },
  { at: "2026-06-12T09:58:00", projectId: "harness-anything", taskId: "KER-106", get summary() { return t("model.mockCatalog.allMaterialsReadyCloseoutReadinessReady"); } },
  { at: "2026-06-12T09:55:00", projectId: "coding-agent-harness", taskId: "DOC-12", get summary() { return t("model.mockCatalog.allMaterialsReadyCloseoutReadinessReady"); } },
  { at: "2026-06-12T09:30:00", projectId: "harness-anything", taskId: "ADP-501", get summary() { return t("model.mockCatalog.snapshotRefreshRawOpenReview"); } },
  { at: "2026-06-12T08:15:00", projectId: "harness-anything", taskId: "KER-102", get summary() { return t("model.mockCatalog.enterFinalizingTemporarilySaveBeforeArchiving"); } },
  { at: "2026-06-12T07:55:00", projectId: "harness-anything", taskId: "FAI-37", get summary() { return t("model.mockCatalog.freshnessDowngradeStaleButUsable"); } },
  { at: "2026-06-11T22:40:00", projectId: "harness-anything", taskId: "LIN-88", get summary() { return t("model.mockCatalog.unmappedRawTriageHoldUnknownAppears"); } },
  { at: "2026-06-11T16:45:00", projectId: "harness-anything", taskId: "CI-602", get summary() { return t("model.mockCatalog.reviewGateMachineJudgmentFailedE2e3"); } },
  { at: "2026-06-11T15:00:00", projectId: "harness-anything", taskId: "STO-210", get summary() { return t("model.mockCatalog.allMaterialsReadyCloseoutReadinessReady"); } },
  { at: "2026-06-10T16:03:00", projectId: "harness-anything", taskId: "KER-104", get summary() { return t("model.mockCatalog.reviewGateMachineJudgmentPassedCanArchived"); } },
];

const SAMPLE_DOCUMENT_KEYS = {
  "contract.md": "model.mockCatalog.taskContractThreePortSchemaContractVerification",
  "design/visual-map.md": "model.mockCatalog.visualMapWritePathMermaidFlowchartLr",
  "review/walkthrough.md": "model.mockCatalog.walkthroughOverviewChanges1AddThreePort",
} as const;

export function getSampleDocument(path: string): string {
  return t(SAMPLE_DOCUMENT_KEYS[path as keyof typeof SAMPLE_DOCUMENT_KEYS]
    ?? "model.mockCatalog.taskContractThreePortSchemaContractVerification");
}
