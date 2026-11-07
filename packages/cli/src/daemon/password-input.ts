import { readFileSync } from "node:fs";

export function readPasswordInput(passwordFile: unknown, passwordStdin: unknown): string {
  if (typeof passwordFile === "string" && passwordStdin === true)
    throw Object.assign(new Error("Choose --password-file or --password-stdin, not both."), { code: "invalid_field" });
  if (typeof passwordFile !== "string" && passwordStdin !== true)
    throw Object.assign(new Error("Password changes require --password-file or --password-stdin."), {
      code: "missing_field",
    });
  if (passwordStdin === true && process.stdin.isTTY)
    throw Object.assign(new Error("--password-stdin requires redirected input."), { code: "invalid_field" });
  try {
    return readFileSync(passwordStdin === true ? 0 : String(passwordFile), "utf8").replace(/\r?\n$/u, "");
  } catch {
    throw Object.assign(new Error("The password input could not be read from the protected file or stdin."), {
      code: "invalid_field",
    });
  }
}
