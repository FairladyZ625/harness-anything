import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandParser } from "../command-spec/types.ts";

export const parseCompletionArgs: CommandParser = (args, rootDir, json) => {
  if (args[0] !== "completion") return null;
  const shell = args[1];
  if (shell !== "bash" && shell !== "zsh") {
    return {
      ok: false,
      error: cliError(
        CliErrorCode.InvalidCompletionShell,
        `Unknown completion shell: ${shell ?? "<missing>"}. Valid shells: bash, zsh. Run 'ha completion bash' or 'ha completion zsh'.`
      )
    };
  }
  return { ok: true, value: { rootDir, json, action: { kind: "completion", shell } } };
};
