import type { RuntimeKindId } from "./agent-runtime.ts";

/** The implementation contract and availability of live steering share this pure registry. */
export type RuntimeSteer =
  | {
      readonly strategy: "interrupt-resume";
      readonly resumeArgs: (args: readonly string[], providerSessionId: string) => readonly string[] | null;
    }
  | { readonly strategy: "cancel-reprompt" };

// Codex spells the three permission modes differently for a fresh exec and for `exec resume`:
// resume is a subcommand with its own parser and rejects `--sandbox` outright (exit 2), accepting
// the bypass flag or `-c sandbox_mode=…` instead. Both blocks live here so launch
// (`agent-runtime-launch-config.ts`) and resume (`steer.resumeArgs` below) read one definition;
// a resume argv built from the fresh block dies before the provider ever sees the thread.
export const codexFreshPermissionArgs = {
    bypass: ["--sandbox", "danger-full-access"],
    "workspace-write": [
      "--sandbox",
      "workspace-write",
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ],
    "read-only": ["--sandbox", "read-only"],
  } as const,
  codexResumePermissionArgs = {
    bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    "workspace-write": [
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ],
    "read-only": ["--config", 'sandbox_mode="read-only"'],
  } as const;

// ACP steering cancels the active turn, then prompts the same session without restarting it.
const acpSteer = { strategy: "cancel-reprompt" } as const;

export const runtimeSteering: Readonly<Record<RuntimeKindId, RuntimeSteer | undefined>> = {
  claude: {
    strategy: "interrupt-resume",
    resumeArgs: (args, providerSessionId) => {
      const clean = [...args],
        index = clean.indexOf("--resume");
      if (index >= 0) clean.splice(index, 2);
      return [...clean, "--resume", providerSessionId];
    },
  },
  codex: {
    strategy: "interrupt-resume",
    resumeArgs: (args, providerSessionId) => {
      // `codex exec resume` is a subcommand with its own parser: it rejects `--sandbox`, which is
      // how a fresh exec spells all three modes, and accepts the bypass flag or `-c sandbox_mode`
      // instead. Production argv always carries the launched block contiguously (`$permission` is
      // one template slot), so replace that block in place with the resume block of the same mode.
      // The mode is read back out of the argv rather than passed in: the argv is the only input
      // both call sites (steer, compaction continuation) share, and a separate parameter could
      // disagree with the mode the dispatch launched with. An argv already carrying the resume
      // block (a resumed dispatch steered again) needs no rewrite.
      const clean = [...args],
        execIndex = clean.indexOf("exec"),
        inputIndex = clean.lastIndexOf("-");
      if (execIndex < 0 || inputIndex < execIndex) return null;
      if (clean[execIndex + 1] === "resume") {
        clean.splice(execIndex + 1, 1);
        clean.splice(clean.lastIndexOf("-") - 1, 1);
      }
      // Named permission profiles are already valid for exec and exec resume. Adding a
      // legacy sandbox block here would override the profile's exact callback socket grant.
      if (!clean.some((token) => token.startsWith("default_permissions="))) {
        const mode = codexPermissionMode(clean);
        if (mode === null) return null;
        const freshBlock = codexFreshPermissionArgs[mode],
          freshIndex = contiguousIndex(clean, freshBlock);
        if (freshIndex >= 0) clean.splice(freshIndex, freshBlock.length, ...codexResumePermissionArgs[mode]);
      }
      // Fail closed without throwing: a block this transform could not recognise would otherwise
      // spawn an argv the resume parser rejects and turn the dispatch into a `gate_red`. Null lets
      // the caller settle on the evidence it already has and record `continuation_refused`.
      if (clean.includes("--sandbox")) return null;
      const options = clean.slice(execIndex + 1, clean.lastIndexOf("-"));
      return [...clean.slice(0, execIndex + 1), "resume", ...options, providerSessionId, "-"];
    },
  },
  agy: undefined,
  zcode: undefined,
  devin: acpSteer,
  cursor: acpSteer,
  "codex-acp": acpSteer,
  "claude-acp": acpSteer,
  copilot: acpSteer,
  auggie: acpSteer,
  droid: acpSteer,
  grok: acpSteer,
  kimi: acpSteer,
  "qwen-code": acpSteer,
  "minimax-code": acpSteer,
  "mistral-vibe": acpSteer,
  junie: acpSteer,
  codebuddy: acpSteer,
  "glm-acp": acpSteer,
  "agy-acp": acpSteer,
  opencode: acpSteer,
  "deepseek-harness": acpSteer,
};

/** Unknown providers cannot acquire control capabilities by default. */
export function runtimeSteerSupported(kindId: string): boolean {
  const strategies: Readonly<Partial<Record<string, RuntimeSteer>>> = runtimeSteering;
  return Object.hasOwn(strategies, kindId) && strategies[kindId] !== undefined;
}

type CodexPermissionMode = keyof typeof codexFreshPermissionArgs;

const codexSandboxModes: Readonly<Record<string, CodexPermissionMode>> = {
  "danger-full-access": "bypass",
  "workspace-write": "workspace-write",
  "read-only": "read-only",
};

/** The mode an argv carries, whether it still has the fresh block or already the resume block. */
function codexPermissionMode(args: readonly string[]): CodexPermissionMode | null {
  if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "bypass";
  const sandboxIndex = args.indexOf("--sandbox");
  if (sandboxIndex >= 0) return codexSandboxModes[args[sandboxIndex + 1] ?? ""] ?? null;
  for (const token of args) {
    const match = /^sandbox_mode="(danger-full-access|workspace-write|read-only)"$/u.exec(
      token.startsWith("--config=") ? token.slice("--config=".length) : token,
    );
    if (match) return codexSandboxModes[match[1]!]!;
  }
  return null;
}

/** First index where `block` appears contiguously in `args`, or -1. */
function contiguousIndex(args: readonly string[], block: readonly string[]): number {
  if (block.length === 0) return -1;
  for (let index = 0; index + block.length <= args.length; index += 1)
    if (block.every((token, offset) => args[index + offset] === token)) return index;
  return -1;
}
