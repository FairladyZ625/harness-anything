import {
  captureCurrentAuthorityPublicationContext,
  currentAuthorityDurableAcceptanceSignal,
  currentAuthoritySettlementReleaseSignal
} from "../../runtime/authority-durable-acceptance-context.ts";
import type { AuthorityPublicationExecutionContext } from "@harness-anything/application";

interface QueuedPublication {
  readonly commandRelease?: Promise<void>;
  readonly durableCut?: Promise<void>;
  readonly publication: (
    context: AuthorityPublicationExecutionContext
  ) => Promise<unknown>;
  readonly runInContext: <Result>(operation: () => Result) => Result;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface PublicationGroup {
  readonly commandRelease?: Promise<void>;
  readonly executionContexts: Set<{ allowDurableSuccessor: boolean }>;
  readonly terminals: Set<Promise<void>>;
  lastDurableCut: Promise<void>;
  acceptingSameCommand: boolean;
}

export function createSerialPublicationExecutor(): {
  readonly run: <Result>(publication: (
    context: AuthorityPublicationExecutionContext
  ) => Promise<Result>) => Promise<Result>;
} {
  const queued: QueuedPublication[] = [];
  let active: PublicationGroup | undefined;

  const startPublication = (
    entry: QueuedPublication,
    after: Promise<void> = Promise.resolve(),
    allowDurableSuccessor = false
  ): {
    readonly terminal: Promise<void>;
    readonly durableCut: Promise<void>;
    readonly executionContext: { allowDurableSuccessor: boolean };
  } => {
    const executionContext = { allowDurableSuccessor };
    const result = after.then(() => entry.runInContext(() => entry.publication(executionContext)));
    void result.then(entry.resolve, entry.reject);
    const terminal = result.then(() => undefined, () => undefined);
    return {
      terminal,
      executionContext,
      durableCut: entry.durableCut
        ? Promise.race([entry.durableCut, terminal])
        : terminal
    };
  };

  const finishGroup = async (group: PublicationGroup): Promise<void> => {
    while (true) {
      const terminals = [...group.terminals];
      await Promise.all(terminals);
      if (terminals.length === group.terminals.size) break;
    }
    group.acceptingSameCommand = false;
    if (active !== group) return;
    active = undefined;
    drain();
  };

  const addToActiveGroup = (group: PublicationGroup, entry: QueuedPublication): void => {
    for (const context of group.executionContexts) context.allowDurableSuccessor = true;
    const started = startPublication(entry, group.lastDurableCut, true);
    group.lastDurableCut = started.durableCut;
    group.executionContexts.add(started.executionContext);
    group.terminals.add(started.terminal);
  };

  const drain = (): void => {
    if (active || queued.length === 0) return;
    const entry = queued.shift()!;
    const started = startPublication(entry);
    const group: PublicationGroup = {
      ...(entry.commandRelease ? { commandRelease: entry.commandRelease } : {}),
      executionContexts: new Set([started.executionContext]),
      terminals: new Set([started.terminal]),
      lastDurableCut: started.durableCut,
      acceptingSameCommand: entry.commandRelease !== undefined
    };
    active = group;
    if (entry.commandRelease) {
      void entry.commandRelease.then(
        () => finishGroup(group),
        () => finishGroup(group)
      );
    } else {
      void started.terminal.then(() => finishGroup(group));
    }
  };

  return {
    run: <Result>(publication: (
      context: AuthorityPublicationExecutionContext
    ) => Promise<Result>): Promise<Result> => {
      const commandRelease = currentAuthoritySettlementReleaseSignal();
      return new Promise<Result>((resolve, reject) => {
        const entry: QueuedPublication = {
          ...(commandRelease ? { commandRelease } : {}),
          ...(currentAuthorityDurableAcceptanceSignal()
            ? { durableCut: currentAuthorityDurableAcceptanceSignal() }
            : {}),
          publication,
          runInContext: captureCurrentAuthorityPublicationContext(),
          resolve: (result) => resolve(result as Result),
          reject
        };
        if (active?.acceptingSameCommand
          && commandRelease
          && active.commandRelease === commandRelease) {
          addToActiveGroup(active, entry);
          return;
        }
        queued.push(entry);
        drain();
      });
    }
  };
}
