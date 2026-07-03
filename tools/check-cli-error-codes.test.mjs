import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findCliErrorCodeViolations } from "./check-cli-error-codes.mjs";

test("CLI error code gate rejects missing registry metadata and inline CliResult errors", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "packages/cli/src/cli/error-codes.ts", `
      export const CliErrorCode = {
        MissingTitle: "missing_title",
        UnknownCommand: "unknown_command"
      } as const;
      export type CliErrorCode = typeof CliErrorCode[keyof typeof CliErrorCode];
      export const cliKernelMappedErrorCodes = new Set<CliErrorCode>([]);
      export const cliCommandLocalErrorCodes = new Set<CliErrorCode>(
        Object.values(CliErrorCode).filter((code): code is CliErrorCode => !cliKernelMappedErrorCodes.has(code as CliErrorCode))
      );
      export const cliErrorCodeRegistry = {
        [CliErrorCode.UnknownCommand]: { category: "parse", defaultHint: "Unknown command." }
      };
      export function cliError(code: CliErrorCode, hint?: string) {
        return { code, hint: hint ?? cliErrorCodeRegistry[code].defaultHint };
      }
      export function isCliErrorCode(value: string): value is CliErrorCode {
        return Object.values(CliErrorCode).includes(value as CliErrorCode);
      }
      export function cliErrorFamily(code: CliErrorCode) {
        return cliKernelMappedErrorCodes.has(code) ? "kernel-mapped" : "command-local";
      }
    `);
    writeFile(rootDir, "packages/cli/src/commands/new-task.ts", `
      export function run() {
        return { ok: false, error: { code: "missing_title", hint: "Use --title." } };
      }
    `);

    const violations = findCliErrorCodeViolations(rootDir);

    assert.equal(violations.includes("CliErrorCode.MissingTitle is missing cliErrorCodeRegistry metadata"), true);
    assert.equal(violations.some((violation) =>
      violation.replaceAll("\\", "/").startsWith("packages/cli/src/commands/new-task.ts:") &&
      violation.includes(`uses inline CliResult error code "missing_title"; use cliError(CliErrorCode.*)`)
    ), true);
  });
});

test("CLI error code gate accepts registry helpers and validation issue codes", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "packages/cli/src/cli/error-codes.ts", `
      export const CliErrorCode = {
        MissingTitle: "missing_title",
        UnknownCommand: "unknown_command"
      } as const;
      export type CliErrorCode = typeof CliErrorCode[keyof typeof CliErrorCode];
      export const cliKernelMappedErrorCodes = new Set<CliErrorCode>([]);
      export const cliCommandLocalErrorCodes = new Set<CliErrorCode>(
        Object.values(CliErrorCode).filter((code): code is CliErrorCode => !cliKernelMappedErrorCodes.has(code as CliErrorCode))
      );
      export const cliErrorCodeRegistry = {
        [CliErrorCode.MissingTitle]: { category: "parse", defaultHint: "Use --title." },
        [CliErrorCode.UnknownCommand]: { category: "parse", defaultHint: "Unknown command." }
      };
      export function cliError(code: CliErrorCode, hint?: string) {
        return { code, hint: hint ?? cliErrorCodeRegistry[code].defaultHint };
      }
      export function isCliErrorCode(value: string): value is CliErrorCode {
        return Object.values(CliErrorCode).includes(value as CliErrorCode);
      }
      export function cliErrorFamily(code: CliErrorCode) {
        return cliKernelMappedErrorCodes.has(code) ? "kernel-mapped" : "command-local";
      }
    `);
    writeFile(rootDir, "packages/cli/src/commands/new-task.ts", `
      import { CliErrorCode, cliError } from "../cli/error-codes.ts";
      export function run() {
        return { ok: false, error: cliError(CliErrorCode.MissingTitle, "Use --title.") };
      }
      export const validationIssues = [{ code: "template_catalog_not_found", path: "$", message: "Missing catalog." }];
    `);

    assert.deepEqual(findCliErrorCodeViolations(rootDir), []);
  });
});

test("CLI error code gate rejects PascalCase adapter codes outside the kernel mapped family", () => {
  withTempRoot((rootDir) => {
    writeFile(rootDir, "packages/cli/src/cli/error-codes.ts", `
      export const CliErrorCode = {
        EngineUnreachable: "EngineUnreachable",
        UnknownCommand: "unknown_command"
      } as const;
      export type CliErrorCode = typeof CliErrorCode[keyof typeof CliErrorCode];
      export const cliKernelMappedErrorCodes = new Set<CliErrorCode>([]);
      export const cliCommandLocalErrorCodes = new Set<CliErrorCode>(
        Object.values(CliErrorCode).filter((code): code is CliErrorCode => !cliKernelMappedErrorCodes.has(code as CliErrorCode))
      );
      export const cliErrorCodeRegistry = {
        [CliErrorCode.EngineUnreachable]: { category: "domain", defaultHint: "Engine unreachable." },
        [CliErrorCode.UnknownCommand]: { category: "parse", defaultHint: "Unknown command." }
      };
      export function cliError(code: CliErrorCode, hint?: string) {
        return { code, hint: hint ?? cliErrorCodeRegistry[code].defaultHint };
      }
      export function isCliErrorCode(value: string): value is CliErrorCode {
        return Object.values(CliErrorCode).includes(value as CliErrorCode);
      }
      export function cliErrorFamily(code: CliErrorCode) {
        return cliKernelMappedErrorCodes.has(code) ? "kernel-mapped" : "command-local";
      }
    `);

    assert.equal(
      findCliErrorCodeViolations(rootDir).includes("PascalCase kernel adapter code CliErrorCode.EngineUnreachable must be in cliKernelMappedErrorCodes"),
      true
    );
  });
});

function writeFile(rootDir, relativePath, body) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

function withTempRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-error-code-gate-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}
