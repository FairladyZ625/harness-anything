// Positive-control fixture: the daemon must not preview startability independently.
export function previewStart(current: {
  readonly snapshot: { readonly task?: { readonly status: string }; readonly lease?: unknown };
}) {
  const preview = true;
  return preview && !current.snapshot.task
    ? false
    : preview && current.snapshot.lease
      ? false
      : isTerminalStatus(current.snapshot.task!.status);
}

function isTerminalStatus(status: string): boolean {
  return status === "done";
}
