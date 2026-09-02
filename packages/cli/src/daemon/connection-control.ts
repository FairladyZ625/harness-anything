import { localUserDaemonEndpoint } from "../../../daemon/src/client/local-daemon-target.ts";
import { requestDaemonJsonRpcAt } from "../../../daemon/src/client/local-json-rpc-client.ts";
import { daemonFailure, daemonOption } from "./control-support.ts";

type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;

export async function runDaemonConnectionControl(
  argv: readonly string[],
  verb: string | undefined,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const connectionId = daemonOption(argv, "--connection") ?? daemonOption(argv, "--connection-id"),
    endpoint = daemonOption(argv, "--endpoint"),
    displayName = daemonOption(argv, "--display-name"),
    state = daemonOption(argv, "--state"),
    reject = (errorCode: string, nextAction: string) =>
      finish(daemonFailure(`daemon-connection-${verb ?? "unknown"}`, errorCode, nextAction), 2);
  if (!verb || !["add", "update", "remove", "probe"].includes(verb))
    return reject("unsupported_command", "Use daemon connection add, update, remove, or probe.");
  if ((verb === "add" || verb === "probe") && !endpoint)
    return reject("missing_field", `Connection ${verb} requires --endpoint.`);
  if ((verb === "update" || verb === "remove") && !connectionId)
    return reject("missing_field", `Connection ${verb} requires --connection.`);
  if (state !== undefined && state !== "enabled" && state !== "disabled")
    return reject("invalid_field", "Use --state enabled or disabled.");
  const method =
      verb === "add"
        ? "daemon.connection.register"
        : verb === "update"
          ? "daemon.connection.update"
          : verb === "remove"
            ? "daemon.connection.unregister"
            : "daemon.connection.probe",
    result = await requestDaemonJsonRpcAt(
      localUserDaemonEndpoint(userRoot, daemonId),
      method,
      {
        ...(connectionId ? { connectionId } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(displayName ? { displayName } : {}),
        ...(state ? { state } : {}),
      },
      75,
    );
  return finish(result, result.ok === true ? 0 : 1);
}
