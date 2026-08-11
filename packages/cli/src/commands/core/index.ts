export { runDiagnosticsCommand } from "./diagnostics.ts";
export { runExtensionRunnerCommand } from "./extension.ts";
export { runGovernanceCommand } from "./governance.ts";
export { runGuiCommand } from "./gui.ts";
export { runHelpCommand } from "./help.ts";
export { runMaterializerCommand } from "./materializer.ts";
export { runCapabilitiesCommand } from "./capabilities.ts";
export { runInitCommand } from "./init.ts";
export { runDecisionCommand } from "./decision.ts";
export { runDistillCommand } from "./distill.ts";
export { runDocCommand } from "./doc.ts";
export { runFactCommand } from "./fact.ts";
export { runMigrationCommand } from "./migration.ts";
export { runRuntimeEventCommand } from "./runtime-event.ts";
export { runSessionCommand } from "./session.ts";
export { runTaskLifecycleFacadeCommand } from "./task-lifecycle-host.ts";
export {
  TASK_LIFECYCLE_CLI_COMMANDS,
  parseTaskLifecycleArgs,
  renderTaskLifecycleHelp,
  runTaskLifecycleFacade
} from "./task-lifecycle.ts";
export type {
  TaskLifecycleFacadeDependencies,
  TaskLifecycleParseResult,
  TaskLifecycleReceipt,
  TaskLifecycleServiceInput,
  TaskLifecycleServicePort
} from "./task-lifecycle.ts";
export { runTaskQueryCommand } from "./task-query.ts";
export { runVersionCommand } from "./version.ts";
export { runWorktreeCommand } from "./worktree.ts";
