import shellNavigation from "./scenarios/shell-navigation.mjs";
import overview from "./scenarios/overview-first-usable.mjs";
import board from "./scenarios/board-preview-detail.mjs";
import taskTerminal from "./scenarios/task-detail-open-terminal.mjs";
import terminalBasics from "./scenarios/terminal-basics.mjs";
import terminalPanes from "./scenarios/terminal-panes.mjs";
import terminalSidebar from "./scenarios/terminal-sidebar.mjs";
import terminalTaskTree from "./scenarios/terminal-task-tree.mjs";
import decisions from "./scenarios/decisions.mjs";
import sessionsArtifacts from "./scenarios/sessions-artifacts.mjs";
import artifactsHtmlPreview from "./scenarios/artifacts-html-preview.mjs";
import settings from "./scenarios/settings-appearance.mjs";

export const catalog = [
  shellNavigation,
  overview,
  board,
  taskTerminal,
  terminalBasics,
  terminalPanes,
  terminalSidebar,
  terminalTaskTree,
  decisions,
  sessionsArtifacts,
  artifactsHtmlPreview,
  settings,
];

export function selectScenarios({ lane, ids }) {
  return catalog.filter(
    (scenario) =>
      (!ids.length || ids.includes(scenario.id)) &&
      (lane === "all" || scenario.lane === "both" || scenario.lane === lane),
  );
}
