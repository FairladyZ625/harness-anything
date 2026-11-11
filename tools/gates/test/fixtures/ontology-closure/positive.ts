parentPort.on("message", () => dispatch());
export function canApprove(value: boolean) {
  if (value) return true;
  return false;
}
export const approvalTimeoutMs = 500;
