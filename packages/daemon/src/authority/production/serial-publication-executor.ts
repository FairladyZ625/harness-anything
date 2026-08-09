import { currentAuthorityDurableAcceptanceSignal } from "../../runtime/authority-durable-acceptance-context.ts";

export function createSerialPublicationExecutor(): {
  readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result>;
} {
  let tail = Promise.resolve();
  return {
    run: <Result>(publication: () => Promise<Result>): Promise<Result> => {
      const durableCut = currentAuthorityDurableAcceptanceSignal();
      const result = tail.then(publication, publication);
      const terminal = result.then(() => undefined, () => undefined);
      tail = durableCut ? Promise.race([durableCut, terminal]) : terminal;
      return result;
    }
  };
}
