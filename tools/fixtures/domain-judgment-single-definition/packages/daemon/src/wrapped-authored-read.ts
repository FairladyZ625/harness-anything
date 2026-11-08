import { readWorkspaceText as readPacketText } from "./workspace-text-port.ts";

function readPacketThroughHelper(root: string, requested: string): string {
  return readPacketText(root, requested, "reviewPacket");
}

export function wrappedAuthoredPacketRead(authoredRoot: string): string {
  return readPacketThroughHelper(authoredRoot, "tasks/example/artifacts/reports/review.json");
}
