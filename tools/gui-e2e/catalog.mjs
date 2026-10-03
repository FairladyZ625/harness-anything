import externalKeycloak from "./scenarios/external-keycloak.mjs";
import shellNavigation from "./scenarios/shell-navigation.mjs";
import overview from "./scenarios/overview-first-usable.mjs";
import board from "./scenarios/board-preview-detail.mjs";
import taskTimelineRecordNavigation from "./scenarios/task-timeline-record-navigation.mjs";
import workProgressChain from "./scenarios/work-progress-chain.mjs";
import decisionSupersedeChain from "./scenarios/decision-supersede-chain.mjs";
import taskTerminal from "./scenarios/task-detail-open-terminal.mjs";
import terminalBasics from "./scenarios/terminal-basics.mjs";
import terminalPanes from "./scenarios/terminal-panes.mjs";
import terminalSidebar from "./scenarios/terminal-sidebar.mjs";
import terminalTaskTree from "./scenarios/terminal-task-tree.mjs";
import decisions from "./scenarios/decisions.mjs";
import decisionReviewResponses from "./scenarios/decision-review-responses.mjs";
import sessionsArtifacts from "./scenarios/sessions-artifacts.mjs";
import artifactsHtmlPreview from "./scenarios/artifacts-html-preview.mjs";
import artifactsRawPreview from "./scenarios/artifacts-raw-preview.mjs";
import artifactsSpreadsheetPreview from "./scenarios/artifacts-spreadsheet-preview.mjs";
import settings from "./scenarios/settings-appearance.mjs";
import declaredEntityKinds from "./scenarios/declared-entity-kinds.mjs";
import systemDaemonLogs from "./scenarios/system-daemon-logs.mjs";
import sessionsGrouping from "./scenarios/sessions-grouping.mjs";
import scheduleRunHistory from "./scenarios/schedule-run-history.mjs";
import daemonStartupWait from "./scenarios/daemon-startup-wait.mjs";
import cadenceView from "./scenarios/cadence-view.mjs";
import taskCloseoutLongValues from "./scenarios/task-closeout-long-values.mjs";
import pageSplitLayout from "./scenarios/page-split-layout.mjs";
import overviewWipRegion from "./scenarios/overview-wip-region.mjs";

export const catalog = [
  externalKeycloak,
  shellNavigation,
  overview,
  board,
  taskTerminal,
  terminalBasics,
  terminalPanes,
  terminalSidebar,
  terminalTaskTree,
  decisions,
  decisionReviewResponses,
  sessionsArtifacts,
  artifactsHtmlPreview,
  artifactsRawPreview,
  artifactsSpreadsheetPreview,
  settings,
  declaredEntityKinds,
  systemDaemonLogs,
  sessionsGrouping,
  scheduleRunHistory,
  daemonStartupWait,
  cadenceView,
  taskTimelineRecordNavigation,
  workProgressChain,
  decisionSupersedeChain,
  taskCloseoutLongValues,
  pageSplitLayout,
  overviewWipRegion,
];

export function selectScenarios({ lane, ids }) {
  return catalog.filter(
    (scenario) =>
      (!ids.length || ids.includes(scenario.id)) &&
      (lane === "all" || scenario.lane === "both" || scenario.lane === lane),
  );
}
