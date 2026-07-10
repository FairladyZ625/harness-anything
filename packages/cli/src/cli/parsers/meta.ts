import type { CommandParser } from "../command-spec/types.ts";

export const parseHelpArgs: CommandParser = (args, rootDir, json) => {
  if (args.length > 0 && !["help", "--help", "-h"].includes(args[0] ?? "")) return null;
  return { ok: true, value: { rootDir, json, action: { kind: "help" } } };
};

export const parseVersionArgs: CommandParser = (args, rootDir, json) => {
  if (args[0] !== "version" && !args.includes("--version") && !args.includes("-v")) return null;
  return { ok: true, value: { rootDir, json, action: { kind: "version" } } };
};
