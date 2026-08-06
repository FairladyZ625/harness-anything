export function waitForDaemonStopSignal(): Promise<{
  readonly reason: "signal";
  readonly signal: "SIGINT" | "SIGTERM";
}> {
  return new Promise((resolve) => {
    const stop = (signal: "SIGINT" | "SIGTERM") => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolve({ reason: "signal", signal });
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  });
}
