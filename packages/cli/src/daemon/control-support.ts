export function daemonOption(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

export function daemonFailure(command: string, errorCode: string, nextAction: string): Record<string, unknown> {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    opId: "N/A",
    origin: "cli",
    code: errorCode,
    evidence: `rejection:${errorCode}`,
    error: { code: errorCode, hint: nextAction },
    nextAction,
  };
}
