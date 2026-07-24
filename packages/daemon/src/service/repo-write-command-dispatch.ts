import type { CommandReceiptEnvelope } from "@harness-anything/application";
import type { RepoWriteProcessSupervisor } from "../runtime/repo-write-process-supervisor.ts";
import type { RepoWriteCommandDto } from "../runtime/repo-write-protocol.ts";

export function repoWriteCommandDispatch(
  supervisor: RepoWriteProcessSupervisor
): {
  readonly repoId: string;
  readonly submit: (command: RepoWriteCommandDto) => Promise<CommandReceiptEnvelope>;
  readonly direct: (command: RepoWriteCommandDto) => Promise<CommandReceiptEnvelope>;
} {
  return {
    repoId: supervisor.status().repoId,
    submit: (command) => supervisor.submit(command),
    direct: (command) => supervisor.direct(command)
  };
}
