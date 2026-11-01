// Windows .cmd/.bat shims cannot be spawned directly: CreateProcess routes them through
// cmd.exe, which re-parses the whole command line with its own rules on top of the target
// program's CRT argv parsing. Two layers have to agree, and cmd.exe expands %VAR% even
// inside double quotes with no escape syntax at all (BatBadBut, CVE-2024-24576). The
// encoding below is the audited scheme from Rust std (sys/args/windows.rs): quote-doubling
// for '"' (zero-width exposure of cmd metacharacters, literal '"' under the CRT
// "double double quotes" rule), the %%cd:~,% prefix to break %VAR% pairing under
// /e:ON /v:OFF, and outright rejection of \r and \n, which cannot survive a cmd /c payload.

// Unquoted pass-through set from Rust std: an unquoted '\' mid-argument is fine; the trailing
// case is handled by the endsWith check below.
const unquotedCmdCharacters = new Set("#$*+-./:?@_\\");

function cmdArgumentNeedsQuotes(value: string): boolean {
  if (value.length === 0 || value.endsWith("\\")) return true;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
    if (codePoint > 0x7f) continue;
    const isAsciiAlphanumeric =
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a);
    if (!isAsciiAlphanumeric && !unquotedCmdCharacters.has(character)) return true;
  }
  return false;
}

/** Encode one argv element for a cmd.exe `/c` command line. Throws on characters that
 * cannot survive cmd.exe parsing (\0, \r, \n) instead of silently mangling or injecting. */
export function escapeCmdArgument(value: string): string {
  if (/[\0\r\n]/u.test(value))
    throw new Error(
      `cmd.exe command lines cannot carry NUL, CR or LF characters: ${JSON.stringify(value.slice(0, 60))}`,
    );
  const quote = cmdArgumentNeedsQuotes(value);
  let encoded = quote ? '"' : "",
    backslashes = 0;
  for (const character of value) {
    if (character === "\\") backslashes += 1;
    else {
      if (character === '"') encoded += "\\".repeat(backslashes) + '"';
      else if (character === "%") encoded += "%%cd:~,";
      backslashes = 0;
    }
    encoded += character;
  }
  if (quote) encoded += "\\".repeat(backslashes) + '"';
  return encoded;
}

/** Wrap a .cmd/.bat script invocation in an explicit cmd.exe argv whose payload is fully
 * controlled by escapeCmdArgument. Spawn the result with windowsVerbatimArguments. */
export function cmdShellInvocation(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: true;
} {
  if (script.includes('"') || script.endsWith("\\"))
    throw new Error(`cmd.exe script paths may not contain '"' or end with '\\': ${script}`);
  return {
    command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
    args: [
      "/e:ON",
      "/v:OFF",
      "/d",
      "/c",
      `""${script}"${args.reduce((payload, argument) => `${payload} ${escapeCmdArgument(argument)}`, "")}"`,
    ],
    windowsVerbatimArguments: true,
  };
}
