import { existsSync, readFileSync, readdirSync, realpathSync, readlinkSync } from "node:fs";
import path from "node:path";
import { managedIdentityPolicy } from "@harness-anything/kernel/internal/domain/managed-identity-policy.ts";
import type { ManagedRbacHost } from "./managed-host.ts";

export async function stopManagedKeycloakOrphan(input: {
  readonly host: ManagedRbacHost;
  readonly root: string;
  readonly java: string;
  readonly keycloakHome: string;
  readonly ports: readonly number[];
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const listeners = await findListenerProcesses(input),
    listenerPorts = [...listeners.byPort.entries()].filter(([, pids]) => pids.size > 0);
  if (listeners.unresolvedPorts.size > 0) {
    const port = [...listeners.unresolvedPorts][0]!;
    throw portInUse(port, input.root, "whose process could not be inspected");
  }
  const pids = new Set(listenerPorts.flatMap(([, owners]) => [...owners]));
  if (pids.size === 0) return;

  const managed = new Set<number>();
  for (const pid of pids) {
    if (!(await matchesManagedKeycloakProcess(input, pid))) {
      const port = listenerPorts.find(([, owners]) => owners.has(pid))?.[0] ?? input.ports[0]!;
      throw portInUse(port, input.root, `owned by process ${pid}, which does not belong to this rbacRoot`);
    }
    managed.add(pid);
  }

  for (const pid of managed) {
    if (input.platform === "win32") await signalProcess(input, pid, "SIGKILL");
    else {
      await signalProcess(input, pid, "SIGTERM");
      await signalProcess(input, pid, "SIGKILL");
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const remaining = await findListenerProcesses(input);
  if (remaining.unresolvedPorts.size > 0) {
    const port = [...remaining.unresolvedPorts][0]!;
    throw portInUse(port, input.root, "whose process could not be inspected after cleanup");
  }
  for (const [port, owners] of remaining.byPort) {
    for (const pid of owners) {
      if (!(await matchesManagedKeycloakProcess(input, pid)))
        throw portInUse(port, input.root, `owned by process ${pid}, which does not belong to this rbacRoot`);
      throw Object.assign(new Error(`Managed Keycloak orphan ${pid} still holds port ${port}.`), {
        code: "rbac_keycloak_orphan_stop_failed",
      });
    }
  }
}

async function findListenerProcesses(input: {
  readonly host: ManagedRbacHost;
  readonly ports: readonly number[];
  readonly platform: NodeJS.Platform;
}): Promise<{ readonly byPort: ReadonlyMap<number, Set<number>>; readonly unresolvedPorts: ReadonlySet<number> }> {
  if (input.platform === "linux") return findLinuxListenerProcesses(input.ports);
  const byPort = new Map<number, Set<number>>(),
    unresolvedPorts = new Set<number>();
  for (const port of input.ports) {
    const result =
      input.platform === "darwin"
        ? await input.host.runProcessExitAsync(
            "lsof",
            ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"],
            undefined,
            undefined,
            undefined,
            undefined,
            { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
          )
        : input.platform === "win32"
          ? await input.host.runProcessExitAsync(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq ${port} } | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ConvertTo-Json -Compress`,
              ],
              undefined,
              undefined,
              undefined,
              undefined,
              { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
            )
          : null;
    if (!result)
      throw Object.assign(new Error(`Cannot inspect managed Keycloak listeners on ${input.platform}.`), {
        code: "rbac_process_inspection_failed",
      });
    if (input.platform === "darwin" && result.exitCode !== 0 && result.exitCode !== 1)
      throw Object.assign(new Error(`Could not inspect listeners on Keycloak port ${port}.`), {
        code: "rbac_process_inspection_failed",
      });
    if (input.platform === "win32" && result.exitCode !== 0)
      throw Object.assign(new Error(`Could not inspect listeners on Keycloak port ${port}.`), {
        code: "rbac_process_inspection_failed",
      });
    const owners = input.platform === "darwin" ? parsePidLines(result.stdout) : parsePidJson(result.stdout);
    byPort.set(port, owners);
  }
  return { byPort, unresolvedPorts };
}

function findLinuxListenerProcesses(ports: readonly number[]): {
  readonly byPort: ReadonlyMap<number, Set<number>>;
  readonly unresolvedPorts: ReadonlySet<number>;
} {
  const inodesByPort = readLinuxListenerInodes(ports);
  const pidByInode = new Map<string, number>(),
    unresolvedPorts = new Set<number>(),
    remaining = new Set([...inodesByPort.values()].flatMap((inodes) => [...inodes]));
  if (remaining.size === 0) return { byPort: new Map(ports.map((port) => [port, new Set<number>()])), unresolvedPorts };
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry),
      descriptors = `/proc/${entry}/fd`;
    let files: string[];
    try {
      files = readdirSync(descriptors);
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    for (const descriptor of files) {
      let target: string;
      try {
        target = readlinkSync(path.join(descriptors, descriptor));
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw error;
      }
      const inode = /^socket:\[(\d+)\]$/u.exec(target)?.[1];
      if (!inode || !remaining.has(inode)) continue;
      pidByInode.set(inode, pid);
      remaining.delete(inode);
      if (remaining.size === 0) break;
    }
    if (remaining.size === 0) break;
  }
  const currentInodesByPort = readLinuxListenerInodes(ports),
    byPort = new Map<number, Set<number>>();
  for (const [port, inodes] of currentInodesByPort) {
    const owners = new Set<number>();
    for (const inode of inodes) {
      const pid = pidByInode.get(inode);
      if (pid === undefined) unresolvedPorts.add(port);
      else owners.add(pid);
    }
    byPort.set(port, owners);
  }
  return { byPort, unresolvedPorts };
}

function readLinuxListenerInodes(ports: readonly number[]): Map<number, Set<string>> {
  const inodesByPort = new Map(ports.map((port) => [port, new Set<string>()]));
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(table)) continue;
    for (const line of readFileSync(table, "utf8").split(/\r?\n/u).slice(1)) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const port = Number.parseInt(fields[1]!.split(":").at(-1)!, 16),
        inodes = inodesByPort.get(port);
      if (inodes) inodes.add(fields[9]!);
    }
  }
  return inodesByPort;
}

async function matchesManagedKeycloakProcess(
  input: {
    readonly host: ManagedRbacHost;
    readonly java: string;
    readonly keycloakHome: string;
    readonly platform: NodeJS.Platform;
  },
  pid: number,
): Promise<boolean> {
  if (!existsSync(input.java) || !existsSync(input.keycloakHome)) return false;
  const java = realpathSync(input.java),
    javaHome = realpathSync(path.dirname(path.dirname(input.java))),
    keycloakHome = realpathSync(input.keycloakHome);
  if (input.platform === "linux") {
    const processRoot = `/proc/${pid}`;
    if (!existsSync(processRoot)) return false;
    const executable = readlinkSync(path.join(processRoot, "exe")).replace(/ \(deleted\)$/u, ""),
      directory = readlinkSync(path.join(processRoot, "cwd")),
      commandLine = readFileSync(path.join(processRoot, "cmdline"), "utf8").replaceAll("\0", " ");
    return (
      path.resolve(executable) === java &&
      pathInside(javaHome, executable) &&
      pathInside(keycloakHome, directory) &&
      commandLine.includes(javaHome) &&
      commandLine.includes(keycloakHome)
    );
  }
  if (input.platform === "darwin") {
    const [image, directory, commandLine] = await Promise.all([
      input.host.runProcessExitAsync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
      ),
      input.host.runProcessExitAsync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
      ),
      input.host.runProcessExitAsync(
        "ps",
        ["-p", String(pid), "-o", "command="],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
      ),
    ]);
    return (
      image.exitCode === 0 &&
      image.stdout.split(/\r?\n/u).includes(`n${java}`) &&
      directory.exitCode === 0 &&
      directory.stdout.split(/\r?\n/u).includes(`n${keycloakHome}`) &&
      commandLine.exitCode === 0 &&
      commandLine.stdout.includes(javaHome) &&
      commandLine.stdout.includes(keycloakHome)
    );
  }
  if (input.platform === "win32") {
    const query =
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
        "if ($null -eq $p) { exit 1 }; " +
        "[pscustomobject]@{ path=$p.ExecutablePath; commandLine=$p.CommandLine } | ConvertTo-Json -Compress",
      process = await input.host.runProcessExitAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", query],
        undefined,
        undefined,
        undefined,
        undefined,
        {
          timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs,
        },
      );
    if (process.exitCode !== 0) return false;
    const observed = JSON.parse(process.stdout) as { readonly path?: string; readonly commandLine?: string },
      commandLine = observed.commandLine ?? "";
    return (
      normalizedWindowsPath(observed.path ?? "") === normalizedWindowsPath(java) &&
      windowsJavaProperty(commandLine, "kc.home.dir", keycloakHome) &&
      windowsManagedRuntime(commandLine, keycloakHome)
    );
  }
  return false;
}

async function signalProcess(
  input: { readonly host: ManagedRbacHost; readonly platform: NodeJS.Platform; readonly root: string },
  pid: number,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (input.platform === "win32") {
    const stopped = await input.host.runProcessExitAsync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      undefined,
      undefined,
      undefined,
      undefined,
      { timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs },
    );
    if (stopped.exitCode !== 0 && (await isWindowsProcessAlive(input.host, pid)))
      throw Object.assign(new Error(`Could not stop managed Keycloak process ${pid} under ${input.root}.`), {
        code: "rbac_keycloak_orphan_stop_failed",
      });
    return true;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function isWindowsProcessAlive(host: ManagedRbacHost, pid: number): Promise<boolean> {
  const result = await host.runProcessExitAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
    ],
    undefined,
    undefined,
    undefined,
    undefined,
    {
      timeoutMs: managedIdentityPolicy.defaultValue.timeoutMs,
    },
  );
  return result.exitCode === 0;
}

function parsePidLines(output: string): Set<number> {
  return new Set(
    output
      .split(/\r?\n/u)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  );
}

function parsePidJson(output: string): Set<number> {
  if (!output.trim()) return new Set();
  const parsed = JSON.parse(output) as number | readonly number[] | null,
    values = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  return new Set(values.filter((pid): pid is number => Number.isSafeInteger(pid) && pid > 0));
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

/** Match one JVM system property in the real JVM option prefix of a Windows command line. */
function windowsJavaProperty(commandLine: string, property: string, value: string): boolean {
  const args = parseWindowsCommandLine(commandLine),
    boundary = javaLauncherBoundary(args);
  if (boundary === undefined) return false;
  const expected = normalizedWindowsPath(value),
    prefix = args.slice(1, boundary.jvmOptionsEnd);
  return prefix.some((arg) => {
    const marker = `-D${property}=`;
    if (!arg.toLowerCase().startsWith(marker.toLowerCase())) return false;
    return normalizedWindowsPath(arg.slice(marker.length)) === expected;
  });
}

/**
 * Keycloak's Java launcher is either a jar or a classpath entry rooted in the managed runtime.
 * Checking the launcher path separately prevents an unrelated Java process in a sibling such as
 * `keycloak-tools` from becoming eligible merely by copying the managed system property.
 */
function windowsManagedRuntime(commandLine: string, keycloakHome: string): boolean {
  const args = parseWindowsCommandLine(commandLine),
    boundary = javaLauncherBoundary(args);
  if (boundary === undefined) return false;
  const managedHome = normalizedWindowsPath(keycloakHome),
    pathOwned = (candidate: string): boolean =>
      path.win32.isAbsolute(candidate) && windowsPathInside(managedHome, candidate);
  if (boundary.jarPath !== undefined) return pathOwned(boundary.jarPath);
  return boundary.classPathEntries.some(pathOwned);
}

interface WindowsJavaBoundary {
  readonly jvmOptionsEnd: number;
  readonly jarPath?: string;
  readonly classPathEntries: readonly string[];
}

/**
 * Parse the Windows command-line grammar used by CommandLineToArgvW, then identify the point at
 * which java stops consuming JVM options. Quoted whitespace and escaped quotes therefore cannot
 * manufacture a `-D` option, and arguments after `-jar` are never treated as JVM options.
 */
function javaLauncherBoundary(args: readonly string[]): WindowsJavaBoundary | undefined {
  if (args.length < 2) return undefined;
  const classPathEntries: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-jar") {
      const jarPath = args[index + 1];
      return jarPath === undefined ? undefined : { jvmOptionsEnd: index, jarPath, classPathEntries };
    }
    if (arg === "-cp" || arg === "-classpath" || arg === "--class-path") {
      const classPath = args[index + 1];
      if (classPath === undefined) return undefined;
      classPathEntries.push(...classPath.split(";"));
      index += 1;
      continue;
    }
    if (arg === "-p" || arg === "--module-path" || arg === "--upgrade-module-path") {
      if (args[index + 1] === undefined) return undefined;
      index += 1;
      continue;
    }
    if (arg === "--") return { jvmOptionsEnd: index, classPathEntries };
    if (arg.startsWith("-")) continue;
    return { jvmOptionsEnd: index, classPathEntries };
  }
  return undefined;
}

function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let argument = "",
    inQuotes = false,
    started = false;
  for (let index = 0; index < commandLine.length; ) {
    const character = commandLine[index]!;
    if (character === "\\") {
      let slashes = 0;
      while (commandLine[index + slashes] === "\\") slashes += 1;
      if (commandLine[index + slashes] === '"') {
        argument += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) {
          argument += '"';
          started = true;
        } else if (inQuotes && commandLine[index + slashes + 1] === '"') {
          argument += '"';
          started = true;
          index += 1;
        } else {
          inQuotes = !inQuotes;
          started = true;
        }
        index += slashes + 1;
        continue;
      }
      argument += "\\".repeat(slashes);
      started = true;
      index += slashes;
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      started = true;
      index += 1;
      continue;
    }
    if ((character === " " || character === "\t") && !inQuotes) {
      if (started) {
        args.push(argument);
        argument = "";
        started = false;
      }
      index += 1;
      continue;
    }
    argument += character;
    started = true;
    index += 1;
  }
  if (started) args.push(argument);
  return args;
}

function windowsPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedWindowsPath(path.win32.resolve(root)),
    normalizedCandidate = normalizedWindowsPath(path.win32.resolve(root, candidate)),
    relative = normalizedWindowsPath(path.win32.relative(normalizedRoot, normalizedCandidate));
  return relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative));
}

function portInUse(port: number, root: string, owner: string): Error {
  return Object.assign(
    new Error(
      `Managed Keycloak cannot start because port ${port} is occupied by a listener ${owner} (expected ${root}).`,
    ),
    { code: "rbac_port_in_use" },
  );
}
