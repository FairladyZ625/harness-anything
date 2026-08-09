export function createSerialPublicationExecutor(): {
  readonly run: <Result>(publication: () => Promise<Result>) => Promise<Result>;
} {
  let tail = Promise.resolve();
  return {
    run: <Result>(publication: () => Promise<Result>): Promise<Result> => {
      const result = tail.then(publication, publication);
      tail = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}
