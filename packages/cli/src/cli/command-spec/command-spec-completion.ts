import { defineCommandSpecs } from "./types.ts";
import { parseCompletionArgs } from "../parsers/completion.ts";
import { runCompletionCommand } from "../../commands/core/completion.ts";

export const completionCommandSpecs = defineCommandSpecs([
  {
    "kind": "completion",
    "usage": "completion <bash|zsh> [--json]",
    "options": [{"flag":"--json","description":"Emit command-receipt/v2 JSON instead of the raw completion script."}],
    "summary": "Generate a shell completion script from the command registry.",
    "examples": ["harness-anything completion zsh", "harness-anything completion bash"],
    "parse": parseCompletionArgs,
    "run": runCompletionCommand,
    "receiptContract": {
      "data": ["shell", "completionScript"],
      "paths": []
    },
    "eventPolicy": {
      "conflictMarkerPreflight": false,
      "runtimeEvent": "none"
    }
  }
]);
