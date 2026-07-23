// @slice-activation P5-W2 repo-writer IPC primitives shared by parent and child transports.
import { RepoWriteSendDeliveryError } from "./repo-write-client.ts";

export function repoWriteIpcJsonText(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error("Repo writer IPC value is not JSON serializable.", { cause: error });
  }
  if (text === undefined) throw new Error("Repo writer IPC value is not a JSON frame.");
  return text;
}

export function serializeRepoWriteIpcFrame<T>(
  message: T,
  stringify: (message: T) => string,
  sender: "parent" | "child"
): object {
  try {
    return JSON.parse(stringify(message)) as object;
  } catch (error) {
    throw new RepoWriteSendDeliveryError(
      "definitely-not-sent",
      `Repo writer ${sender} frame could not be serialized for IPC.`,
      { cause: error }
    );
  }
}

export function notifyRepoWriteDisconnectListeners(
  listeners: ReadonlyArray<(error: Error) => void>,
  error: Error,
  defer: boolean
): void {
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(error);
      } catch {
        // The transport is terminal; one observer must not suppress the
        // disconnect signal for the remaining clients.
      }
    }
  };
  if (defer) queueMicrotask(notify);
  else notify();
}
