#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assessHermeticConfig({ userRoot, daemonId, userRootSource, home = homedir() }) {
  const failures = [];
  const defaultUserRoot = path.resolve(home, ".harness");
  const effectiveDaemonId = daemonId ?? "default";

  if (userRoot === undefined) {
    failures.push("user-root source: pass --user-root explicitly; implicit daemon configuration is not permitted.");
  } else if (path.resolve(userRoot) === defaultUserRoot) {
    failures.push(`user-root path: ${defaultUserRoot} is the default daemon root; choose a dedicated directory.`);
  } else if (userRootSource !== "flag") {
    failures.push("user-root source: pass --user-root explicitly; an environment-only value is not an auditable isolation boundary.");
  }

  if (userRoot !== undefined && path.resolve(userRoot) === defaultUserRoot && effectiveDaemonId === "default") {
    failures.push("socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint.");
  }

  return { ok: failures.length === 0, failures, effectiveDaemonId };
}

export function parsePreflightArgs(argv, env = process.env) {
  let userRoot;
  let daemonId;
  let userRootSource = env.HARNESS_DAEMON_USER_ROOT === undefined ? undefined : "environment";
  let daemonIdSource = env.HARNESS_DAEMON_ID === undefined ? undefined : "environment";
  if (userRootSource === "environment") userRoot = env.HARNESS_DAEMON_USER_ROOT;
  if (daemonIdSource === "environment") daemonId = env.HARNESS_DAEMON_ID;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--user-root") {
      if (!value) throw new Error("--user-root requires a value");
      userRoot = value;
      userRootSource = "flag";
      index += 1;
      continue;
    }
    if (arg === "--daemon-id") {
      if (!value) throw new Error("--daemon-id requires a value");
      daemonId = value;
      daemonIdSource = "flag";
      index += 1;
      continue;
    }
    throw new Error(`unknown test-hermetic-preflight option: ${arg}`);
  }
  return { userRoot, daemonId, userRootSource, daemonIdSource };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try {
    config = parsePreflightArgs(argv, env);
  } catch (error) {
    console.error(`test-hermetic-preflight: ${error.message}`);
    return 2;
  }
  const result = assessHermeticConfig(config);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    return 1;
  }
  console.log(`PASS hermetic test configuration: user-root=${path.resolve(config.userRoot)} daemon-id=${result.effectiveDaemonId} socket-namespace=derived-from-user-root-and-daemon-id`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
