import { spawn, type ChildProcess } from "node:child_process";
import { consumeKnownError } from "@harness-anything/kernel";

export type EdgeJoinTunnelState = "connecting" | "connected" | "reconnecting" | "stopped";

export interface EdgeJoinTunnelPorts {
  readonly fleet: number;
  readonly login: number;
}

export interface EdgeJoinSshTunnelInput {
  readonly target: string;
  readonly fleetServicePort: number;
  readonly fleetServiceHost: string;
  readonly loginServicePort: number;
  readonly loginServiceHost: string;
  readonly remotePorts?: EdgeJoinTunnelPorts;
}

type TunnelInput = EdgeJoinSshTunnelInput & { readonly remotePorts: EdgeJoinTunnelPorts };

interface TunnelEntry extends Omit<EdgeJoinSshTunnelInput, "remotePorts"> {
  remotePorts?: EdgeJoinTunnelPorts;
  state: EdgeJoinTunnelState;
  process?: ChildProcess;
  output: string;
  readyServices: Set<keyof EdgeJoinTunnelPorts>;
  allocatedPorts: { fleet?: number; login?: number };
  attempt?: {
    readonly promise: Promise<EdgeJoinTunnelPorts>;
    resolve: (ports: EdgeJoinTunnelPorts) => void;
    reject: (error: Error) => void;
    settled: boolean;
  };
  cancelRestart?: () => void;
  cancelStartupTimeout?: () => void;
  stopping: boolean;
}

interface TunnelManagerPorts {
  readonly spawn?: typeof spawn;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly onState?: (target: string, state: EdgeJoinTunnelState) => void;
}

const restartDelayMs = 5_000;
const startupTimeoutMs = 45_000;

export class EdgeJoinSshTunnelManager {
  readonly #entries = new Map<string, TunnelEntry>();
  readonly #spawn: typeof spawn;
  readonly #schedule: NonNullable<TunnelManagerPorts["schedule"]>;
  readonly #onState: NonNullable<TunnelManagerPorts["onState"]>;
  #closed = false;

  constructor(ports: TunnelManagerPorts = {}) {
    this.#spawn = ports.spawn ?? spawn;
    this.#schedule =
      ports.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.#onState = ports.onState ?? (() => undefined);
  }

  async start(input: EdgeJoinSshTunnelInput): Promise<EdgeJoinTunnelPorts> {
    if (this.#closed) throw tunnelError("The daemon is shutting down.");
    const target = validateSshTarget(input.target),
      existing = this.#entries.get(target);
    if (existing) {
      assertSameServicePorts(existing, input);
      if (existing.state === "connected" && existing.remotePorts) return existing.remotePorts;
      if (existing.attempt && !existing.attempt.settled) return existing.attempt.promise;
      if (existing.process || existing.cancelRestart) return existing.attempt!.promise;
      return this.#launch(existing);
    }
    const entry: TunnelEntry = {
      ...input,
      target,
      ...(input.remotePorts ? { remotePorts: input.remotePorts } : {}),
      state: "connecting",
      output: "",
      readyServices: new Set(),
      allocatedPorts: {},
      stopping: false,
    };
    this.#entries.set(target, entry);
    return this.#launch(entry);
  }

  resume(input: TunnelInput): void {
    void this.start(input).catch(() => undefined);
  }

  state(target: string): EdgeJoinTunnelState | "stopped" {
    return this.#entries.get(target)?.state ?? "stopped";
  }

  release(target: string): void {
    const entry = this.#entries.get(target);
    if (entry) void this.#stopEntry(entry);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => this.#stopEntry(entry)));
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.stopAll();
  }

  #launch(entry: TunnelEntry): Promise<EdgeJoinTunnelPorts> {
    entry.state = "connecting";
    entry.output = "";
    entry.readyServices = new Set();
    entry.allocatedPorts = {};
    entry.stopping = false;
    this.#onState(entry.target, entry.state);
    let resolve!: (ports: EdgeJoinTunnelPorts) => void, reject!: (error: Error) => void;
    const promise = new Promise<EdgeJoinTunnelPorts>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    entry.attempt = { promise, resolve, reject, settled: false };
    try {
      const child = this.#spawn("ssh", sshTunnelArgs(entry), {
        cwd: process.cwd(),
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      entry.process = child;
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => this.#readOutput(entry, chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => this.#readOutput(entry, chunk));
      let exited = false;
      const finish = (exitCode: number, cause?: Error) => {
        if (exited) return;
        exited = true;
        this.#exited(entry, exitCode, cause);
      };
      child.once("error", (error) => finish(1, error));
      child.once("exit", (code) => finish(code ?? 1));
      entry.cancelStartupTimeout = this.#schedule(() => {
        entry.cancelStartupTimeout = undefined;
        if (entry.state !== "connected" && this.#entries.get(entry.target) === entry) {
          const error = tunnelError("OpenSSH did not establish both remote forwards within 45 seconds.");
          if (entry.attempt && !entry.attempt.settled) {
            entry.attempt.settled = true;
            entry.attempt.reject(error);
          }
          entry.state = "reconnecting";
          this.#onState(entry.target, entry.state);
          const child = entry.process;
          if (child) child.kill("SIGTERM");
          else this.#exited(entry, 1, error);
        }
      }, startupTimeoutMs);
    } catch (error) {
      this.#exited(entry, 1, error instanceof Error ? error : new Error(String(error)));
      consumeKnownError(error);
    }
    return promise;
  }

  #readOutput(entry: TunnelEntry, chunk: string): void {
    if (entry.state === "reconnecting") return;
    entry.output += chunk;
    const lines = entry.output.split(/\r?\n/u);
    entry.output = lines.pop() ?? "";
    for (const line of lines) this.#readForwardLine(entry, line);
    if (entry.output.length > 8_192) entry.output = entry.output.slice(-8_192);
  }

  #readForwardLine(entry: TunnelEntry, line: string): void {
    const allocated = /Allocated port (\d+) for remote forward to (.+):(\d+)/u.exec(line),
      fixed =
        /(?:Remote connections from (?:LOCALHOST|127\.0\.0\.1):(\d+) forwarded to local address (.+):(\d+)|remote forward success for: listen 127\.0\.0\.1:(\d+), connect (.+):(\d+))/iu.exec(
          line,
        );
    if (allocated) {
      const remotePort = Number(allocated[1]),
        serviceHost = normalizeHost(allocated[2]!),
        servicePort = Number(allocated[3]);
      if (servicePort === entry.fleetServicePort && serviceHost === normalizeHost(entry.fleetServiceHost)) {
        this.#setRemotePort(entry, "fleet", remotePort);
        entry.readyServices.add("fleet");
      }
      if (servicePort === entry.loginServicePort && serviceHost === normalizeHost(entry.loginServiceHost)) {
        this.#setRemotePort(entry, "login", remotePort);
        entry.readyServices.add("login");
      }
    } else if (fixed && entry.remotePorts) {
      const remotePort = Number(fixed[1] ?? fixed[4]),
        serviceHost = normalizeHost(fixed[2] ?? fixed[5]!),
        servicePort = Number(fixed[3] ?? fixed[6]);
      if (
        (servicePort === entry.fleetServicePort &&
          serviceHost === normalizeHost(entry.fleetServiceHost) &&
          remotePort === entry.remotePorts.fleet) ||
        (servicePort === entry.loginServicePort &&
          serviceHost === normalizeHost(entry.loginServiceHost) &&
          remotePort === entry.remotePorts.login)
      )
        entry.readyServices.add(
          servicePort === entry.fleetServicePort &&
            serviceHost === normalizeHost(entry.fleetServiceHost) &&
            remotePort === entry.remotePorts.fleet
            ? "fleet"
            : "login",
        );
    }
    if (entry.remotePorts && entry.readyServices.has("fleet") && entry.readyServices.has("login")) {
      entry.state = "connected";
      entry.cancelStartupTimeout?.();
      entry.cancelStartupTimeout = undefined;
      this.#onState(entry.target, entry.state);
      if (entry.attempt && !entry.attempt.settled) {
        entry.attempt.settled = true;
        entry.attempt.resolve(entry.remotePorts);
      }
    }
  }

  #setRemotePort(entry: TunnelEntry, service: keyof EdgeJoinTunnelPorts, port: number): void {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return;
    entry.allocatedPorts[service] = port;
    if (entry.allocatedPorts.fleet !== undefined && entry.allocatedPorts.login !== undefined)
      entry.remotePorts = entry.allocatedPorts as EdgeJoinTunnelPorts;
  }

  #exited(entry: TunnelEntry, exitCode: number, cause?: Error): void {
    if (this.#entries.get(entry.target) !== entry) return;
    entry.process = undefined;
    entry.cancelStartupTimeout?.();
    entry.cancelStartupTimeout = undefined;
    if (entry.stopping || this.#closed) return;
    const error = cause ?? tunnelError(`OpenSSH exited before the two forwards were ready (code ${exitCode}).`);
    if (entry.attempt && !entry.attempt.settled) {
      entry.attempt.settled = true;
      entry.attempt.reject(error);
    }
    entry.state = "reconnecting";
    this.#onState(entry.target, entry.state);
    if (!entry.cancelRestart)
      entry.cancelRestart = this.#schedule(() => {
        entry.cancelRestart = undefined;
        if (this.#entries.get(entry.target) === entry && !entry.stopping && !this.#closed)
          void this.#launch(entry).catch(() => undefined);
      }, restartDelayMs);
  }

  async #stopEntry(entry: TunnelEntry): Promise<void> {
    if (this.#entries.get(entry.target) !== entry) return;
    entry.stopping = true;
    entry.cancelRestart?.();
    entry.cancelRestart = undefined;
    entry.cancelStartupTimeout?.();
    entry.cancelStartupTimeout = undefined;
    this.#entries.delete(entry.target);
    entry.state = "stopped";
    this.#onState(entry.target, entry.state);
    const child = entry.process;
    entry.process = undefined;
    if (entry.attempt && !entry.attempt.settled) {
      entry.attempt.settled = true;
      entry.attempt.reject(tunnelError("The SSH tunnel was stopped."));
    }
    if (!child) return;
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  }
}

export function validateSshTarget(value: string): string {
  const target = value.trim();
  if (
    target.length === 0 ||
    target.startsWith("-") ||
    !/^(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*)$/u.test(target)
  )
    throw Object.assign(new Error("Enter an SSH config alias or user@host without command options."), {
      code: "edge_join_ssh_target_invalid",
    });
  return target;
}

function sshTunnelArgs(entry: TunnelEntry): string[] {
  const args = [
    "-S",
    "none",
    "-N",
    "-T",
    "-v",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  for (const service of ["fleet", "login"] as const) {
    const localPort = service === "fleet" ? entry.fleetServicePort : entry.loginServicePort,
      localHost = service === "fleet" ? entry.fleetServiceHost : entry.loginServiceHost,
      remotePort = entry.remotePorts?.[service] ?? 0;
    args.push("-R", `127.0.0.1:${remotePort}:${openSshHost(localHost)}:${localPort}`);
  }
  args.push(entry.target);
  return args;
}

function assertSameServicePorts(entry: TunnelEntry, input: EdgeJoinSshTunnelInput): void {
  if (
    entry.fleetServicePort !== input.fleetServicePort ||
    normalizeHost(entry.fleetServiceHost) !== normalizeHost(input.fleetServiceHost) ||
    entry.loginServicePort !== input.loginServicePort ||
    normalizeHost(entry.loginServiceHost) !== normalizeHost(input.loginServiceHost) ||
    (input.remotePorts &&
      entry.remotePorts &&
      (input.remotePorts.fleet !== entry.remotePorts.fleet || input.remotePorts.login !== entry.remotePorts.login))
  )
    throw tunnelError("An SSH target already has a tunnel for different service addresses.");
}

function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/gu, "").toLowerCase();
}

function openSshHost(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function tunnelError(message: string): Error {
  return Object.assign(new Error(message), { code: "edge_join_ssh_failed" });
}
