import path from "node:path";
import {
  commandInterceptionHook,
  commandInterceptionProgram,
  type CommandInterceptions,
} from "./runtime-command-interceptions.ts";

/** These native adapters take an invocation-local settings file or plugin directory. */
export function commandInterceptionNeedsFiles(kindId: string): boolean {
  return ["cursor", "copilot", "auggie", "droid"].includes(kindId);
}

/** Plan files below runtime-owned scratch; the instance store materializes them only after authentication succeeds. */
export function compileCommandInterceptionFiles(
  kindId: string,
  rules: CommandInterceptions,
  directory: string,
): { readonly args: readonly string[]; readonly files: readonly { readonly path: string; readonly body: string }[] } {
  const files: { path: string; body: string }[] = [];
  const write = (relative: string, value: unknown) =>
      files.push({ path: path.join(directory, relative), body: `${JSON.stringify(value)}\n` }),
    manifest = { name: "harness-command-interception", version: "1.0.0" },
    nativeHooks = (matcher: string) => ({
      PreToolUse: [{ matcher, hooks: [{ type: "command", command: commandInterceptionHook(rules) }] }],
    });
  if (kindId === "droid") {
    write("settings.json", { hooks: nativeHooks("Execute"), disableAllHooks: false });
    return { args: ["--settings", path.join(directory, "settings.json")], files };
  }
  if (kindId === "cursor") {
    write(".cursor-plugin/plugin.json", manifest);
    write("hooks/hooks.json", {
      version: 1,
      hooks: { beforeShellExecution: [{ command: commandInterceptionHook(rules, "cursor") }] },
    });
  } else if (kindId === "copilot") {
    write("plugin.json", { ...manifest, hooks: "hooks/hooks.json" });
    write("hooks/hooks.json", {
      version: 1,
      hooks: {
        preToolUse: [
          {
            type: "command",
            matcher: "bash|powershell",
            exec: process.execPath,
            args: ["-e", commandInterceptionProgram(rules, "copilot")],
          },
        ],
      },
    });
  } else if (kindId === "auggie") {
    write(".augment-plugin/marketplace.json", { ...manifest, plugins: [{ ...manifest, source: "./plugin" }] });
    write("plugin/.augment-plugin/plugin.json", manifest);
    write("plugin/hooks/hooks.json", { hooks: nativeHooks("bash") });
  } else throw new Error(`No native file hook adapter for ${kindId}.`);
  return { args: ["--plugin-dir", directory], files };
}
