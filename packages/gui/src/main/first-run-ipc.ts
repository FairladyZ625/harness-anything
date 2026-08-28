import { statSync } from "node:fs";
import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import {
  FIRST_RUN_BOOTSTRAP_CHANNEL,
  FIRST_RUN_CHOOSE_CHANNEL,
  type FirstRunBootstrapInput,
} from "../api/first-run-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface FirstRunRegistrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, payload: unknown) => Promise<unknown>,
  ) => void;
}

export interface FirstRunServices {
  readonly chooseRepository: () => Promise<string | null>;
  readonly bootstrap: (input: FirstRunBootstrapInput) => Promise<unknown>;
}

export function registerFirstRunIpcHandlers(
  registrar: FirstRunRegistrar,
  services: FirstRunServices,
  trustPolicy: IpcWebContentsTrustPolicy,
): void {
  registrar.handle(FIRST_RUN_CHOOSE_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    if (payload !== null && payload !== undefined)
      throw new Error("First-run directory selection does not accept a payload.");
    return services.chooseRepository();
  });
  registrar.handle(FIRST_RUN_BOOTSTRAP_CHANNEL, async (event, payload) => {
    assertTrustedIpcSender(event, trustPolicy);
    return services.bootstrap(validateFirstRunBootstrapInput(payload));
  });
}

export function validateFirstRunBootstrapInput(value: unknown): FirstRunBootstrapInput {
  if (!record(value)) throw new Error("First-run setup requires an object payload.");
  const fields = ["rootDir", "repoId", "personId", "displayName", "name", "addNpmScripts"];
  if (Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error("First-run setup contains unsupported fields.");
  if (typeof value.rootDir !== "string" || !path.isAbsolute(value.rootDir))
    throw new Error("First-run repository path must be absolute.");
  try {
    if (!statSync(value.rootDir).isDirectory()) throw new Error("First-run repository path must be a directory.");
  } catch (error) {
    if (error instanceof Error && error.message === "First-run repository path must be a directory.") throw error;
    throw new Error("First-run repository path does not exist.");
  }
  if (typeof value.repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.repoId))
    throw new Error("First-run repo id must use lowercase letters, numbers, and hyphens.");
  if (typeof value.personId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(value.personId))
    throw new Error("First-run person id has an invalid format.");
  if (!oneLine(value.displayName)) throw new Error("First-run display name must be one non-empty line.");
  if (value.name !== undefined && !oneLine(value.name))
    throw new Error("First-run workspace name must be one non-empty line.");
  if (value.addNpmScripts !== undefined && typeof value.addNpmScripts !== "boolean")
    throw new Error("First-run npm script selection must be boolean.");
  return value as unknown as FirstRunBootstrapInput;
}

function oneLine(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
