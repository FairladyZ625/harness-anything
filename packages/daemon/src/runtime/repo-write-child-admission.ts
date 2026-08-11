export async function runWithRepoWriteDirectAdmission<Result>(
  begin: (() => () => void) | undefined,
  operation: (release: () => void) => Promise<Result>
): Promise<Result> {
  const releaseAdmission = begin?.();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseAdmission?.();
  };
  try {
    return await operation(release);
  } finally {
    release();
  }
}

export function releaseDirectAdmissionBeforeExecution<Input, Result>(
  execute: (input: Input) => Result,
  release: () => void
): (input: Input) => Result {
  return (input) => {
    release();
    return execute(input);
  };
}
