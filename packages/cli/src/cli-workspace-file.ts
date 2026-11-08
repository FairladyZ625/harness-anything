import { readWorkspaceText } from "@harness-anything/preset/internal/preset-command-contract";

/**
 * The one CLI-side boundary for a repository file: `--body-file`, `--from-file`, `--prompt-file`,
 * `--batch-file` and their peers name paths relative to the selected workspace root. A caller can
 * spell the same file relative or absolute; both resolve inside that root, and an outside path is
 * refused here before a command handler reads it.
 */
export function readWorkspaceTextFile(rootDir: string, value: string, flag: string): string {
  try {
    return readWorkspaceText(rootDir, value, flag);
  } catch (error) {
    if (error instanceof Error && /outside the workspace boundary/u.test(error.message))
      throw Object.assign(new Error(`${flag} must stay within the selected repository.`, { cause: error }), {
        code: "invalid_field",
      });
    throw error;
  }
}
