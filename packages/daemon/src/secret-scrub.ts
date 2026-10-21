// One scrubber for every surface that carries provider or operator text off this process: the
// durable dispatch stream, and the rejection explanations a repo cell hands back to the CLI, the
// GUI and an agent's prompt. It is a leaf module (no daemon imports) so the error boundary can
// redact without pulling the dispatch stream into its import graph.
//
// A key naming a token carries a credential when its value is a string, and LLM usage telemetry
// (input_tokens, totalTokens, token_count) when it is a number or a structure of numbers. The value
// type is the line: the durable replay path re-feeds persisted provider events after a daemon
// restart, so dropping the counters would erase an adopted session's usage at settlement, while a
// string under any token-named key (id_token, github_token, a bare token) never leaves the process.
const tokenKey = /token/iu,
  forbiddenKey = new RegExp(
    [
      "credential",
      "password",
      "secret",
      "authorization",
      "executablepath",
      "api[-_ ]?key",
      "private[-_ ]?key",
      "cookie",
    ].join("|"),
    "iu",
  ),
  bearer = /\bBearer\s+[^\s,;]+/giu,
  knownToken = /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{8,}\b/giu,
  executionCredential = /harness-execution-[A-Za-z0-9._-]+:[A-Za-z0-9_-]{43}/gu,
  sensitiveAssignment =
    /\b(?:authorization|cookie|credential(?:Ref)?|executablePath|api[-_ ]?key|accessToken|apiToken|password|private[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;}]+/giu;

export function scrubProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => !forbiddenKey.test(key) && !(tokenKey.test(key) && typeof entry === "string"))
        .map(([key, entry]) => [key, scrubProviderValue(entry)]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(bearer, "Bearer [REDACTED]")
    .replace(knownToken, "[REDACTED]")
    .replace(executionCredential, "[REDACTED]")
    .replace(sensitiveAssignment, "[REDACTED]");
}

/** The same credential rules, for a single line of prose an error message can safely carry. */
export function scrubSecretText(text: string): string {
  return String(scrubProviderValue(text));
}
