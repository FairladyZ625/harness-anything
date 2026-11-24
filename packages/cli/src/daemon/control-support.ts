import path from "node:path";

export type CliFleetEdgeTrustAnchors = {
  readonly caPaths?: readonly string[];
  readonly spkiSha256?: readonly string[];
};

const SPKI_SHA256_PATTERN = /^(?:sha256:)?([a-f0-9]{64})$/u;

export function daemonOption(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

export function daemonOptions(argv: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    values.push(value === undefined ? "" : value);
    index += 1;
  }
  return values;
}

export function parseTrustAnchorFlags(
  argv: readonly string[],
):
  | { readonly ok: true; readonly trustAnchors: CliFleetEdgeTrustAnchors | undefined }
  | { readonly ok: false; readonly nextAction: string } {
  const rawCaPaths = daemonOptions(argv, "--trust-ca"),
    rawSpki = daemonOptions(argv, "--trust-spki-sha256");
  if (rawCaPaths.length === 0 && rawSpki.length === 0) return { ok: true, trustAnchors: undefined };
  if (rawCaPaths.some((item) => item.trim().length === 0 || item.startsWith("--")))
    return { ok: false, nextAction: "Provide a non-empty file path for each --trust-ca flag." };
  if (rawSpki.some((item) => item.trim().length === 0 || item.startsWith("--")))
    return {
      ok: false,
      nextAction: "Provide a lowercase SHA-256 digest (optional sha256: prefix) for each --trust-spki-sha256 flag.",
    };
  const caPaths: string[] = [];
  const seenCa = new Set<string>();
  for (const raw of rawCaPaths) {
    const resolved = path.resolve(raw);
    if (!seenCa.has(resolved)) {
      seenCa.add(resolved);
      caPaths.push(resolved);
    }
  }
  const spkiSha256: string[] = [];
  const seenSpki = new Set<string>();
  for (const raw of rawSpki) {
    const match = SPKI_SHA256_PATTERN.exec(raw.trim());
    if (!match)
      return {
        ok: false,
        nextAction: "Provide a lowercase 64-hex SHA-256 digest (optional sha256: prefix) for --trust-spki-sha256.",
      };
    const digest = match[1]!;
    if (!seenSpki.has(digest)) {
      seenSpki.add(digest);
      spkiSha256.push(digest);
    }
  }
  return {
    ok: true,
    trustAnchors: {
      ...(caPaths.length > 0 ? { caPaths } : {}),
      ...(spkiSha256.length > 0 ? { spkiSha256 } : {}),
    },
  };
}

export function resolveFleetEdgeSyncInputs(
  argv: readonly string[],
  edgeConfig: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly spkiSha256?: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
  } | null,
):
  | {
      readonly ok: true;
      readonly host: string;
      readonly port: string | number;
      readonly caPath: string;
      readonly nodeId: string;
      readonly viewRoot: string;
      readonly quotaBytes: string | number;
      readonly credential: string;
      readonly servername: string | undefined;
      readonly trustAnchors: CliFleetEdgeTrustAnchors | undefined;
    }
  | { readonly ok: false; readonly code: string; readonly nextAction: string } {
  const flag = (name: string) => daemonOption(argv, name),
    host = flag("--host") ?? edgeConfig?.host,
    port = flag("--port") ?? edgeConfig?.port,
    caPath = flag("--ca") ?? edgeConfig?.caPath,
    nodeId = flag("--node-id") ?? edgeConfig?.nodeId,
    viewRoot = flag("--view-root") ?? edgeConfig?.viewRoot,
    quotaBytes = flag("--quota-bytes") ?? edgeConfig?.quotaBytes;
  if (
    host === undefined ||
    port === undefined ||
    caPath === undefined ||
    nodeId === undefined ||
    viewRoot === undefined ||
    quotaBytes === undefined
  )
    return {
      ok: false,
      code: "missing_field",
      nextAction: "Add edge connection fields or populate the node fleet-edge.json.",
    };
  const credential = flag("--credential") ?? edgeConfig?.credential;
  if (credential === undefined)
    return {
      ok: false,
      code: "missing_field",
      nextAction: "Add --credential, or set credential in the node fleet-edge.json.",
    };
  const trustAnchorParse = parseTrustAnchorFlags(argv);
  if (!trustAnchorParse.ok) return { ok: false, code: "invalid_field", nextAction: trustAnchorParse.nextAction };
  return {
    ok: true,
    host,
    port,
    caPath,
    nodeId,
    viewRoot,
    quotaBytes,
    credential,
    servername: flag("--servername") ?? edgeConfig?.servername,
    trustAnchors: trustAnchorParse.trustAnchors,
  };
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
