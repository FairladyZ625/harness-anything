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
  // Hosted-provider personal tokens have pinned prefixes: GitHub `gh[posur]_`, GitLab `glpat-`.
  // The punctuation anchor is what keeps ordinary words from matching.
  providerToken = /\b(?:gh[posur]_[A-Za-z0-9]{8,}|glpat-[-_A-Za-z0-9]{8,})/gu,
  // Cloud key ids carry a fixed vendor prefix and a fixed body length, so a prose word cannot
  // accidentally satisfy them. AWS key ids are 20 chars: a 4-char type prefix plus 16 upper-case
  // alphanumerics. Google API keys are `AIza` plus 35 URL-safe characters.
  awsAccessKeyId = /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[0-9A-Z]{16}(?![-_A-Za-z0-9])/gu,
  googleApiKey = /\bAIza[0-9A-Za-z_-]{35}(?![-_A-Za-z0-9])/gu,
  // A JWT is three dot-separated segments; the `eyJ` header is base64url for `{"`. Two-segment
  // lookalikes and one-segment edge-join payloads stay readable.
  jsonWebToken = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![-_A-Za-z0-9])/gu,
  // PEM private key blocks (RSA/EC/OPENSSH/encrypted/PGP) never leave the process. A truncated
  // block with no footer still redacts through the end of the string rather than leaking the body.
  privateKeyBlock =
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gu,
  // A URL's userinfo is a credential transport (`https://user:pass@host`, `https://token@host`),
  // and remotes other than git (proxies, API clients) print it verbatim. The host stays so the
  // sentence still names the remote that failed.
  urlUserInfo = /(https?:\/\/)[^\s/@]+@/giu,
  executionCredential = /harness-execution-[A-Za-z0-9._-]+:[A-Za-z0-9_-]{43}/gu,
  // The leading `(?:[A-Za-z0-9]+[-_])*` is what catches env spellings such as `OPENAI_API_KEY`,
  // `AWS_SECRET_ACCESS_KEY` and `GITHUB_TOKEN`: a `\bapi` anchor fails after `_`, so the key name
  // is matched as a whole. The separator and the value's opening quote are kept, which makes the
  // rewrite idempotent and leaves JSON transcripts parseable.
  sensitiveAssignment =
    /\b((?:[A-Za-z0-9]+[-_])*(?:authorization|cookie|credential(?:Ref)?|executablePath|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|secret[-_ ]?key|accessToken|apiToken|password|secret|token))((?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)[^\s,;}"']+/giu,
  // A secret the process itself minted or read at runtime, whose text carries no pinned prefix
  // (a legacy 40-hex GitHub token). Prefix rules cannot see it, so the exact value is registered
  // here once and redacted wherever it appears. The set is bounded: a long-lived daemon rotates
  // tokens, and retaining every historical value would be a leak of its own.
  registeredSecrets = new Set<string>(),
  registeredSecretLimit = 64,
  registeredSecretMinimumLength = 8;

/** Registers one exact secret value (a token) so every scrubber surface redacts it verbatim. */
export function registerSecretValue(value: string): void {
  if (value.length < registeredSecretMinimumLength) return;
  registeredSecrets.delete(value);
  registeredSecrets.add(value);
  if (registeredSecrets.size > registeredSecretLimit)
    registeredSecrets.delete(registeredSecrets.values().next().value!);
}

export function scrubProviderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => !forbiddenKey.test(key) && !(tokenKey.test(key) && typeof entry === "string"))
        .map(([key, entry]) => [key, scrubProviderValue(entry)]),
    );
  if (typeof value !== "string") return value;
  let scrubbed = value;
  for (const secret of registeredSecrets)
    if (scrubbed.includes(secret)) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  return scrubbed
    .replace(urlUserInfo, "$1[REDACTED]@")
    .replace(bearer, "Bearer [REDACTED]")
    .replace(privateKeyBlock, "[REDACTED]")
    .replace(awsAccessKeyId, "[REDACTED]")
    .replace(googleApiKey, "[REDACTED]")
    .replace(knownToken, "[REDACTED]")
    .replace(providerToken, "[REDACTED]")
    .replace(jsonWebToken, "[REDACTED]")
    .replace(executionCredential, "[REDACTED]")
    .replace(sensitiveAssignment, "$1$2[REDACTED]");
}

/** The same credential rules, for a single line of prose an error message can safely carry. */
export function scrubSecretText(text: string): string {
  return String(scrubProviderValue(text));
}
