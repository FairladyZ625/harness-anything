import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import {
  EDGE_JOIN_ENTRY_CHANNEL,
  type EdgeJoinEntryRequest,
} from "@harness-anything/authorization-gui/edge-join-entry-contract";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>,
  ) => void;
}

export const EDGE_JOIN_LINK_PREFIX = "harness-edge://join/";
/** A link is one base64url JSON blob; real ones stay far below this, so longer input is refused. */
const EDGE_JOIN_LINK_MAX = 4096;

/** OS protocol activations carry one argument shaped like an invitation link, nothing else. */
export function edgeJoinLinkFromArgv(argv: readonly string[]): string | null {
  const link = argv.find((argument) => argument.startsWith(EDGE_JOIN_LINK_PREFIX));
  return link !== undefined && link.length <= EDGE_JOIN_LINK_MAX ? link : null;
}

/**
 * The edge joiner's typed channel to the daemon's existing edge join. The join and its polling run in
 * the renderer; this handler only carries narrowed requests to `daemon.rbac.manage` and the answers
 * back, refusals included. `open-login` opens exactly the verification URI the daemon last returned —
 * the renderer never chooses a URL.
 */
export function registerEdgeJoinEntryIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: {
    readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
    readonly openExternal: (url: string) => Promise<void>;
  },
): void {
  let loginUri: string | null = null;
  registrar.handle(EDGE_JOIN_ENTRY_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const request = edgeJoinEntryParams(input);
    if (request.kind === "open-login") {
      if (loginUri === null) throw new Error("No edge join sign-in is waiting.");
      await ports.openExternal(loginUri);
      return { ok: true };
    }
    const reply =
      request.kind === "join"
        ? await ports.daemonRequest({
            operation: "edge-join",
            link: request.link,
            ...(request.originUrls === undefined ? {} : { originUrls: request.originUrls }),
          })
        : await ports.daemonRequest({ operation: request.kind === "poll" ? "login-poll" : "edge-join-progress" });
    if (typeof reply.verificationUri === "string" && reply.verificationUri !== "") {
      // Only an https page the daemon's device login named is ever opened; renderer input cannot pick a URL.
      if (new URL(reply.verificationUri).protocol !== "https:")
        throw new Error("The daemon returned a non-https sign-in page.");
      loginUri = reply.verificationUri;
    }
    return reply;
  });
}

export function edgeJoinEntryParams(input: unknown): EdgeJoinEntryRequest {
  const request = (typeof input === "object" && input !== null ? input : {}) as Readonly<Record<string, unknown>>,
    kind = String(request.kind);
  const unknown = Object.keys(request).filter((key) => !["kind", "link", "originUrls"].includes(key));
  if (unknown.length > 0) throw new Error(`Edge join does not take ${unknown.join(", ")}.`);
  if (kind === "poll" || kind === "progress" || kind === "open-login") {
    if (Object.hasOwn(request, "link") || Object.hasOwn(request, "originUrls"))
      throw new Error(`Edge join ${kind} does not take join details.`);
    return { kind };
  }
  if (kind !== "join") throw new Error(`Edge join does not offer ${kind}.`);
  const link = request.link;
  if (
    typeof link !== "string" ||
    !link.startsWith(EDGE_JOIN_LINK_PREFIX) ||
    // A bare scheme prefix carries no invitation payload; refuse it here rather than at the daemon decode.
    link.length <= EDGE_JOIN_LINK_PREFIX.length ||
    link.length > EDGE_JOIN_LINK_MAX
  )
    throw new Error("Paste a harness-edge://join/ invitation link.");
  const originUrls = readOriginUrls(request.originUrls);
  return { kind: "join", link, ...(originUrls === undefined ? {} : { originUrls }) };
}

function readOriginUrls(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Edge join origin addresses must be a repository-to-address map.");
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(
      ([repoId, address]) =>
        !repoId ||
        repoId.length > 128 ||
        typeof address !== "string" ||
        !address.trim() ||
        address.length > 2_048 ||
        /[\0\r\n]/u.test(address),
    )
  )
    throw new Error("Edge join origin addresses contain an invalid repository or address.");
  return Object.fromEntries(entries) as Record<string, string>;
}
