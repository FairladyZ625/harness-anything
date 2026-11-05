#!/usr/bin/env node

import { statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseToolOptions,
  renderToolHelp,
  testHermeticPreflightCommand,
  toolOption,
  toolValue,
} from "./tool-command-contract.mjs";

function readDirectoryIdentity(target) {
  const { dev, ino } = statSync(target);
  return { dev, ino };
}

function sameIdentity(left, right) {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function identityOrMissing(target, readIdentity) {
  try {
    return readIdentity(target);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function assessHermeticConfig({
  userRoot,
  daemonId,
  userRootSource,
  identityHome = userInfo().homedir,
  readIdentity = readDirectoryIdentity,
}) {
  const failures = [];
  // The production daemon root belongs to the account, not to the mutable HOME a runtime may
  // redirect; otherwise an injected HOME makes the real default root look dedicated.
  const defaultUserRoot = path.resolve(identityHome, ".harness");
  const effectiveDaemonId = daemonId ?? toolOption(testHermeticPreflightCommand, "--daemon-id").defaultValue;
  const resolvedUserRoot = userRoot === undefined ? undefined : path.resolve(userRoot);
  let sameDefaultRoot = resolvedUserRoot !== undefined && resolvedUserRoot === defaultUserRoot;
  let identityFailure;

  // A different path spelling can still be the same directory: case-insensitive file systems and
  // symlinks both resolve to the production root's device/inode. Compare that identity whenever
  // both paths exist; a path that cannot be inspected is rejected rather than assumed distinct.
  if (resolvedUserRoot !== undefined && !sameDefaultRoot) {
    try {
      sameDefaultRoot = sameIdentity(
        identityOrMissing(defaultUserRoot, readIdentity),
        identityOrMissing(resolvedUserRoot, readIdentity),
      );
    } catch (error) {
      identityFailure = error;
    }
  }

  if (userRoot === undefined) {
    failures.push("user-root source: pass --user-root explicitly; implicit daemon configuration is not permitted.");
  } else if (sameDefaultRoot) {
    failures.push(`user-root path: ${defaultUserRoot} is the default daemon root; choose a dedicated directory.`);
  } else if (userRootSource !== "flag") {
    failures.push(
      "user-root source: pass --user-root explicitly; an environment-only value is not an auditable isolation boundary.",
    );
  }

  if (identityFailure !== undefined) {
    failures.push(
      `user-root path: cannot verify ${resolvedUserRoot} is not the default daemon root: ${identityFailure.code ?? identityFailure.message}`,
    );
  }

  if (sameDefaultRoot && effectiveDaemonId === "default") {
    failures.push(
      "socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint.",
    );
  }

  return { ok: failures.length === 0, failures, effectiveDaemonId };
}

export function parsePreflightArgs(argv, env = process.env) {
  const parsed = parseToolOptions(testHermeticPreflightCommand, argv);
  if (parsed.help) return { help: true };
  let userRoot = toolValue(parsed, "--user-root");
  let daemonId = toolValue(parsed, "--daemon-id");
  let userRootSource = env.HARNESS_DAEMON_USER_ROOT === undefined ? undefined : "environment";
  let daemonIdSource = env.HARNESS_DAEMON_ID === undefined ? undefined : "environment";
  if (userRoot === undefined && userRootSource === "environment") userRoot = env.HARNESS_DAEMON_USER_ROOT;
  else if (userRoot !== undefined) userRootSource = "flag";
  if (daemonId === undefined && daemonIdSource === "environment") daemonId = env.HARNESS_DAEMON_ID;
  else if (daemonId !== undefined) daemonIdSource = "flag";
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
  if (config.help) {
    console.log(renderToolHelp(testHermeticPreflightCommand));
    return 0;
  }
  const result = assessHermeticConfig(config);
  if (!result.ok) {
    for (const failure of result.failures) console.error(`FAIL ${failure}`);
    return 1;
  }
  console.log(
    `PASS hermetic test configuration: user-root=${path.resolve(config.userRoot)} daemon-id=${result.effectiveDaemonId} socket-namespace=derived-from-user-root-and-daemon-id`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
