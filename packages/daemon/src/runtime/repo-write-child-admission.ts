export async function runWithRepoWriteDirectAdmission<Result>(
  begin: (() => () => void) | undefined,
  operation: () => Promise<Result>
): Promise<Result> {
  const release = begin?.();
  try {
    return await operation();
  } finally {
    release?.();
  }
}
