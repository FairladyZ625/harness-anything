import { readFileSync } from "node:fs";

/** Only the daemon transport consumes these source selectors; the key never becomes argv. */
export function runtimeCredentialInput(action: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { apiKeyStdin, apiKeyFile, ...metadata } = action;
  if (apiKeyStdin === undefined && apiKeyFile === undefined) return metadata;
  if (apiKeyStdin && apiKeyFile !== undefined)
    throw Object.assign(new Error("Choose --api-key-stdin or --api-key-file, not both."), { code: "invalid_field" });
  if (apiKeyStdin && process.stdin.isTTY)
    throw Object.assign(new Error("--api-key-stdin requires redirected input; use a protected file or pipe."), {
      code: "invalid_field",
    });
  let text: string;
  try {
    text = readFileSync(apiKeyStdin ? 0 : String(apiKeyFile), "utf8");
  } catch {
    throw Object.assign(
      new Error("The API key input could not be read. Check the protected file or redirected stdin."),
      { code: "invalid_field" },
    );
  }
  return { ...metadata, apiKey: text.trim() };
}
