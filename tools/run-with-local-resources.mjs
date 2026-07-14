#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverQosPrefix, prefixCommand, withLocalHeavySlot } from "./local-resource-governance.mjs";

export function parseResourceWrapperArgs(argv) {
  let label = "local-heavy-command";
  let index = 0;
  if (argv[0] === "--label") {
    if (!argv[1]) throw new Error("--label requires a value");
    label = argv[1];
    index = 2;
  }
  if (argv[index] !== "--") throw new Error("expected -- before the wrapped command");
  const command = argv[index + 1];
  if (!command) throw new Error("wrapped command is required");
  return { label, command, args: argv.slice(index + 2) };
}

export function buildWrappedInvocation(qosPrefix, command, args) {
  return prefixCommand(qosPrefix, command, args);
}

async function main(argv) {
  const options = parseResourceWrapperArgs(argv);
  process.exitCode = await withLocalHeavySlot({ label: options.label }, async (lease) => {
    const qosPrefix = lease.inherited ? [] : discoverQosPrefix();
    const invocation = buildWrappedInvocation(qosPrefix, options.command, options.args);
    console.error(
      `[local-qos] ${options.label}: QoS=${qosPrefix.join(" ") || "inherited"}; ` +
      `slot=${path.basename(lease.slotPath)}`
    );
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit", env: lease.childEnv });
    return new Promise((resolveExitCode) => {
      child.once("error", (error) => {
        console.error(`[local-qos] failed to launch ${options.command}: ${error.message}`);
        resolveExitCode(1);
      });
      child.once("close", (code, signal) => {
        if (signal !== null) {
          console.error(`[local-qos] ${options.label} terminated by ${signal}`);
          resolveExitCode(1);
          return;
        }
        resolveExitCode(code ?? 1);
      });
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[local-qos] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
