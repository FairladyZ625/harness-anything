import type { SettingsV1 } from "@harness-anything/kernel";
import { formatShellCommand } from "./shell-command-text.ts";

export type CommandInterceptions = SettingsV1["runtime"]["commandInterceptions"];

/** Frozen into one provider launch; the hook never rereads a mutable repository file. */
type NativeHookFormat = "pre-tool-use" | "cursor" | "copilot";

export function commandInterceptionProgram(
  rules: CommandInterceptions,
  format: NativeHookFormat = "pre-tool-use",
): string {
  return `(${intercept.toString()})(${JSON.stringify(rules)},${JSON.stringify(format)})`;
}

export function commandInterceptionHook(
  rules: CommandInterceptions,
  format: NativeHookFormat = "pre-tool-use",
): string {
  const source = commandInterceptionProgram(rules, format),
    program = `eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())`;
  // Native Windows hooks use cmd.exe unless the provider declares a different shell.
  // Only the fixed program and base64 travel through that shell; rule text is never shell code.
  return process.platform === "win32"
    ? `"${process.execPath}" -e "${program}"`
    : formatShellCommand(process.execPath, ["-e", program]);
}

// This function is also the native hook program. Keep it self-contained so source and
// packaged launches run exactly the same program, with no dependency on the worker cwd.
function intercept(rules: CommandInterceptions, format: NativeHookFormat): void {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    body += chunk;
  });
  process.stdin.on("end", () => {
    const deny = (reason: string): void => {
      if (format === "cursor") {
        process.stdout.write(JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }));
        return;
      }
      if (format === "copilot") {
        process.stdout.write(JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }));
        return;
      }
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    };
    const input = JSON.parse(body) as {
        command?: string;
        toolArgs?: string;
        tool_input?: { command?: string; cmd?: string };
      },
      args = format === "copilot" ? (JSON.parse(input.toolArgs ?? "{}") as { command?: string }) : input.tool_input,
      command = format === "cursor" ? input.command : (args?.command ?? input.tool_input?.cmd);
    if (typeof command !== "string") {
      deny("HA command interception: provider supplied no shell command text.");
      return;
    }
    const rule = rules.find((candidate) => {
      if (!("pattern" in candidate)) return false;
      return new RegExp(candidate.pattern, "u").test(command);
    });
    if (rule && "pattern" in rule) deny(`HA command interception '${rule.id}' matched /${rule.pattern}/.`);
    else if (format === "cursor") process.stdout.write(JSON.stringify({ permission: "allow" }));
  });
}
