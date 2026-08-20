import { writeFileSync } from "node:fs";
import path from "node:path";

// Shared provider-executable fixture: `body` is plain JavaScript that runs
// under this repository's Node, and the platform decides what "executable"
// means. POSIX keeps the classic form — a shebang script at `target` itself,
// mode 0o755, byte-identical to the inline writes this helper replaced.
// Windows has no shebang loader and no execute bit, so the identical script
// lands at `target` (extension preserved: an extensionless file stays
// CommonJS, `.mjs` stays ESM) and a `.cmd` shim beside it forwards the exact
// argv (`%*`) into Node. That shim is the one launch shape every product
// surface already supports: runExecutableSync, nativeCommand, and
// terminalCommand route `.cmd` through cmd.exe, and discoverRuntimeInstallations
// scans the ["", ".cmd", ".exe"] suffixes on PATH. Returns the path that must
// be used as the installation's executablePath on this platform — the shim on
// Windows, `target` elsewhere.
export function writeProviderExecutable(target: string, body: string): string {
  writeFileSync(target, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  if (process.platform !== "win32") return target;
  const script = path.basename(target), shim = path.join(path.dirname(target), `${script.replace(/\.mjs$/u, "")}.cmd`);
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0${script}" %*\r\n`);
  return shim;
}
