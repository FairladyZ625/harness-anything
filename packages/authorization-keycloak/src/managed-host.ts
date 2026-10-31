export interface ManagedRbacHost {
  readonly runProcessText: (command: string, args: readonly string[]) => string;
  readonly runProcessTextAsync: (command: string, args: readonly string[]) => Promise<string>;
  readonly runProcessExitAsync: (
    command: string,
    args: readonly string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
    input?: string,
    signal?: AbortSignal,
    options?: { readonly timeoutMs?: number; readonly windowsVerbatimArguments?: boolean; readonly maxBuffer?: number },
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly validateCertificateNames: (certificate: Buffer, names: readonly string[]) => void;
  readonly mapListenerBindError: (error: unknown) => Error;
}
