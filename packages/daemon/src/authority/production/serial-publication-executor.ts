import {
  captureCurrentAuthorityPublicationContext,
  currentAuthorityDurableAcceptanceSignal
} from "../../runtime/authority-durable-acceptance-context.ts";
import type { AuthorityPublicationExecutionContext } from "@harness-anything/application";

interface PublicationTail {
  readonly durableCut: Promise<void>;
  readonly terminal: Promise<void>;
  readonly execution: { allowDurableSuccessor: boolean; reportDurableCut: () => void };
}

/**
 * Serializes only the authoritative publication cut. Canonical settlement may
 * continue after durable acceptance, but a successor cannot enter before the
 * preceding publication either reports that cut or terminates.
 */
export function createSerialPublicationExecutor(): {
  readonly run: <Result>(publication: (
    context: AuthorityPublicationExecutionContext
  ) => Promise<Result>) => Promise<Result>;
} {
  let tail: PublicationTail | undefined;

  return {
    run: <Result>(publication: (
      context: AuthorityPublicationExecutionContext
    ) => Promise<Result>): Promise<Result> => {
      const previous = tail;
      const durableAcceptance = currentAuthorityDurableAcceptanceSignal();
      let reportDurableCut!: () => void;
      const reportedDurableCut = new Promise<void>((resolve) => {
        reportDurableCut = resolve;
      });
      const execution = {
        allowDurableSuccessor: previous !== undefined,
        ...(durableAcceptance ? { durableAcceptance } : {}),
        reportDurableCut
      };
      if (previous) previous.execution.allowDurableSuccessor = true;
      const runInContext = captureCurrentAuthorityPublicationContext();
      const result = (previous?.durableCut ?? Promise.resolve())
        .then(() => runInContext(() => publication(execution)));
      const terminal = result.then(() => undefined, () => undefined);
      const current: PublicationTail = {
        execution,
        terminal,
        durableCut: Promise.race([
          reportedDurableCut,
          ...(durableAcceptance ? [durableAcceptance] : []),
          terminal
        ])
      };
      tail = current;
      void terminal.then(() => {
        if (tail === current) tail = undefined;
      });
      return result;
    }
  };
}
