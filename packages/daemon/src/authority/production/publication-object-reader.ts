import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBoundedRetryBudget, type BoundedRetryBudget } from "@harness-anything/kernel";
import type { RetryBudgetSignal } from "../../observability/visible-retry-budget.ts";

const maximumBatchHeaderBytes = 64 * 1024;
const maximumGitObjectBytes = 64 * 1024 * 1024;
const exactSha1Pattern = /^[a-f0-9]{40}$/u;
const batchHeaderPattern = /^([a-f0-9]{40}) ([a-z]+) ([0-9]+)$/u;
const maximumConsecutiveRebuilds = 1;
const readersByRoot = new Map<string, PublicationGitObjectReader>();
const canonicalRootsByInput = new Map<string, string>();
const execFileAsync = promisify(execFile);
const publicationReaderRegistrySymbol = Symbol.for(
  "harness-anything.publication-reader-ownership-registry"
);

interface PublicationReaderOwnershipRegistry {
  readonly register: (snapshot: () => ReadonlyArray<{
    readonly root: string;
    readonly owner: PublicationReaderOwner;
  }>) => void;
}

export interface PublicationReaderOwner {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
}

publicationReaderOwnershipRegistry()?.register(() => [...readersByRoot.values()].map((reader) => ({
  root: reader.rootDir,
  owner: reader.owner
})));

export class GitObjectBatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitObjectBatchValidationError";
  }
}

export class GitObjectBatchMissingError extends Error {
  constructor(objectName: string) {
    super(`AUTHORITY_GIT_OBJECT_MISSING:object=${objectName}`);
    this.name = "GitObjectBatchMissingError";
  }
}

export function assertVerifiedGitObjectContent(input: {
  readonly requestedOid: string;
  readonly objectType: string;
  readonly declaredSize: number;
  readonly content: Buffer;
  readonly trailingByte: number;
}): void {
  if (input.content.length !== input.declaredSize) {
    throw new GitObjectBatchValidationError(
      `AUTHORITY_GIT_OBJECT_SIZE_MISMATCH:expected=${input.declaredSize};actual=${input.content.length}`
    );
  }
  if (input.trailingByte !== 0x0a) {
    throw new GitObjectBatchValidationError(
      `AUTHORITY_GIT_OBJECT_TRAILING_LF_MISSING:actual=${input.trailingByte}`
    );
  }
  const observedOid = createHash("sha1")
    .update(`${input.objectType} ${input.declaredSize}\0`)
    .update(input.content)
    .digest("hex");
  if (observedOid !== input.requestedOid) {
    throw new GitObjectBatchValidationError(
      `AUTHORITY_GIT_OBJECT_HASH_MISMATCH:requested=${input.requestedOid};observed=${observedOid}`
    );
  }
}

export function readPublicationGitObject(
  rootDir: string,
  objectName: string,
  options: {
    readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
    readonly owner?: PublicationReaderOwner;
  } = {}
): Promise<Buffer> {
  const inputRoot = path.resolve(rootDir);
  const canonicalRoot = canonicalGitRoot(rootDir);
  canonicalRootsByInput.set(inputRoot, canonicalRoot);
  let reader = readersByRoot.get(canonicalRoot);
  if (!reader) {
    reader = new PublicationGitObjectReader(
      canonicalRoot,
      options.owner ?? publicationReaderOwner(),
      options.onRetryBudgetSignal
    );
    readersByRoot.set(canonicalRoot, reader);
  } else if (options.onRetryBudgetSignal) {
    reader.useRetryBudgetSignal(options.onRetryBudgetSignal);
  }
  return reader.read(objectName);
}

export async function shutdownPublicationGitObjectReader(rootDir: string): Promise<void> {
  const inputRoot = path.resolve(rootDir);
  const canonicalRoot = canonicalRootsByInput.get(inputRoot) ?? existingCanonicalGitRoot(inputRoot);
  if (!canonicalRoot) return;
  const reader = readersByRoot.get(canonicalRoot);
  if (!reader) return;
  await reader.close();
  if (readersByRoot.get(canonicalRoot) === reader) {
    readersByRoot.delete(canonicalRoot);
    for (const [knownInput, knownCanonical] of canonicalRootsByInput) {
      if (knownCanonical === canonicalRoot) canonicalRootsByInput.delete(knownInput);
    }
  }
}

export function openPublicationGitObjectReadersWithin(rootDir?: string): ReadonlyArray<{
  readonly root: string;
  readonly owner: PublicationReaderOwner;
}> {
  const containingRoot = rootDir === undefined ? undefined : resolvedExistingPath(rootDir);
  return [...readersByRoot.values()]
    .filter((reader) => containingRoot === undefined || pathContains(containingRoot, reader.rootDir))
    .map((reader) => ({ root: reader.rootDir, owner: reader.owner }))
    .sort((left, right) => left.root.localeCompare(right.root));
}

function publicationReaderOwnershipRegistry(): PublicationReaderOwnershipRegistry | undefined {
  const registry = (globalThis as typeof globalThis & {
    [key: symbol]: PublicationReaderOwnershipRegistry | undefined;
  })[publicationReaderRegistrySymbol];
  return registry;
}

function resolvedExistingPath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function pathContains(containingRoot: string, candidate: string): boolean {
  const relative = path.relative(containingRoot, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function publicationReaderOwner(): PublicationReaderOwner {
  const internalFiles = new Set([
    fileURLToPath(import.meta.url),
    path.resolve(import.meta.dirname, "publication-evidence.ts")
  ]);
  for (const line of new Error().stack?.split("\n").slice(1) ?? []) {
    const match = /(?:\(|at )((?:file:\/\/\/|\/|[A-Za-z]:[\\/]).+):(\d+):(\d+)\)?$/u.exec(line.trim());
    if (!match) continue;
    const file = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!;
    if (!internalFiles.has(file)) {
      return { file, line: Number(match[2]), column: Number(match[3]) };
    }
  }
  return { file: "unknown" };
}

class PublicationGitObjectReader {
  readonly rootDir: string;
  readonly owner: PublicationReaderOwner;
  private batch: GitCatFileBatchProcess | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private batchDisabled = false;
  private readonly retryBudget: BoundedRetryBudget;
  private onRetryBudgetSignal: ((signal: RetryBudgetSignal) => void) | undefined;

  constructor(
    rootDir: string,
    owner: PublicationReaderOwner,
    onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void
  ) {
    this.rootDir = rootDir;
    this.owner = owner;
    this.onRetryBudgetSignal = onRetryBudgetSignal;
    this.retryBudget = createBoundedRetryBudget({
      operation: "publication-git-object-batch",
      budget: { maxRetries: maximumConsecutiveRebuilds },
      onExhausted: (event) => {
        if (this.onRetryBudgetSignal) {
          this.onRetryBudgetSignal({ phase: "exhausted", event });
        } else {
          reportBatchFailure(
            "AUTHORITY_GIT_OBJECT_BATCH_RETRY_BUDGET_EXHAUSTED",
            this.rootDir,
            event.cause,
            "batch=disabled;request=fork"
          );
        }
      }
    });
  }

  useRetryBudgetSignal(signal: (signal: RetryBudgetSignal) => void): void {
    this.onRetryBudgetSignal = signal;
  }

  read(objectName: string): Promise<Buffer> {
    const result = this.queue.then(() => this.readSerial(objectName));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const batch = this.batch;
    this.batch = undefined;
    if (batch) await batch.terminate();
    await this.queue;
  }

  private async readSerial(objectName: string): Promise<Buffer> {
    if (this.closed) throw new Error("AUTHORITY_GIT_OBJECT_READER_CLOSED");
    if (this.batchDisabled || objectName.includes("\n")) {
      return oneShotGitObject(this.rootDir, objectName);
    }
    this.batch ??= new GitCatFileBatchProcess(this.rootDir);
    const batch = this.batch;
    let response: Awaited<ReturnType<GitCatFileBatchProcess["read"]>>;
    try {
      response = await batch.read(objectName);
    } catch (error) {
      this.batch = undefined;
      await batch.terminate();
      if (this.closed) throw error;
      const decision = this.retryBudget.recordFailure(error);
      if (decision.status === "retry-allowed") {
        this.batch = new GitCatFileBatchProcess(this.rootDir);
        reportBatchFailure(
          "AUTHORITY_GIT_OBJECT_BATCH_RESTARTED",
          this.rootDir,
          error,
          `rebuild=${decision.retriesUsed + 1}/${maximumConsecutiveRebuilds};request=fork`
        );
      } else {
        this.batchDisabled = true;
      }
      return oneShotGitObject(this.rootDir, objectName);
    }
    this.retryBudget.reset();
    if (response.missing) throw new GitObjectBatchMissingError(objectName);
    return response.content;
  }
}

class GitCatFileBatchProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: BufferedBatchOutput;
  private childClosed = false;
  private stderr = "";
  private spawnError: Error | undefined;

  constructor(rootDir: string) {
    this.child = spawn("git", ["-C", rootDir, "cat-file", "--batch"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.output = new BufferedBatchOutput(this.child.stdout);
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      if (this.stderr.length < maximumBatchHeaderBytes) {
        this.stderr += Buffer.from(chunk).toString("utf8");
      }
    });
    this.child.on("error", (error) => {
      this.spawnError = error;
    });
    this.child.once("close", () => {
      this.childClosed = true;
    });
    unrefChild(this.child);
  }

  async read(objectName: string): Promise<
    | { readonly missing: true }
    | { readonly missing: false; readonly content: Buffer }
  > {
    refChild(this.child);
    try {
      await writeBatchRequest(this.child, objectName);
      const header = (await this.output.readLine()).toString("utf8");
      if (header === `${objectName} missing`) return { missing: true };
      const parsed = batchHeaderPattern.exec(header);
      if (!parsed) {
        throw new GitObjectBatchValidationError(
          `AUTHORITY_GIT_OBJECT_BATCH_HEADER_INVALID:header=${JSON.stringify(header)}`
        );
      }
      const [, resolvedOid, objectType, sizeText] = parsed;
      // The repository queue permits only one outstanding request. Git's header
      // therefore resolves this exact object expression to the oid checked below;
      // a prior response cannot remain buffered after its size and LF validated.
      if (exactSha1Pattern.test(objectName) && resolvedOid !== objectName) {
        throw new GitObjectBatchValidationError(
          `AUTHORITY_GIT_OBJECT_RESPONSE_OID_MISMATCH:requested=${objectName};resolved=${resolvedOid}`
        );
      }
      const declaredSize = Number(sizeText);
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maximumGitObjectBytes) {
        throw new GitObjectBatchValidationError(
          `AUTHORITY_GIT_OBJECT_SIZE_INVALID:size=${sizeText}`
        );
      }
      const content = await this.output.readExactly(declaredSize);
      const trailing = await this.output.readExactly(1);
      assertVerifiedGitObjectContent({
        requestedOid: resolvedOid!,
        objectType: objectType!,
        declaredSize,
        content,
        trailingByte: trailing[0] ?? -1
      });
      return { missing: false, content };
    } catch (error) {
      if (error instanceof GitObjectBatchValidationError) throw error;
      throw new GitObjectBatchValidationError(
        `AUTHORITY_GIT_OBJECT_BATCH_READ_FAILED:${gitObjectReadErrorMessage(this.spawnError ?? error)}${this.stderr ? `;stderr=${this.stderr.trim()}` : ""}`
      );
    } finally {
      unrefChild(this.child);
    }
  }

  async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) {
      if (await waitForOwnedProcessesToClose([], () => this.childClosed, 250)) return;
      throw new Error("AUTHORITY_GIT_OBJECT_BATCH_TERMINATION_TIMEOUT:pid=unknown;remaining=stdio");
    }
    const ownedPids = await ownedProcessTree(pid);
    this.child.stdin.destroy();
    if (process.platform === "win32") {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await terminateWindowsProcessTree(pid);
      }
    } else {
      signalOwnedProcesses(ownedPids, "SIGTERM");
    }
    if (await waitForOwnedProcessesToClose(ownedPids, () => this.childClosed, 250)) return;
    signalOwnedProcesses(ownedPids, "SIGKILL");
    if (await waitForOwnedProcessesToClose(ownedPids, () => this.childClosed, 250)) return;
    throw new Error(
      `AUTHORITY_GIT_OBJECT_BATCH_TERMINATION_TIMEOUT:pid=${pid};remaining=${ownedPids.filter(isProcessAlive).join(",") || "stdio"}`
    );
  }
}

class BufferedBatchOutput {
  private readonly iterator: AsyncIterator<string | Buffer>;
  private buffered = Buffer.alloc(0);

  constructor(output: NodeJS.ReadableStream & AsyncIterable<string | Buffer>) {
    this.iterator = output[Symbol.asyncIterator]();
  }

  async readLine(): Promise<Buffer> {
    while (true) {
      const newline = this.buffered.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffered.subarray(0, newline);
        this.buffered = this.buffered.subarray(newline + 1);
        return line;
      }
      if (this.buffered.length > maximumBatchHeaderBytes) {
        throw new GitObjectBatchValidationError("AUTHORITY_GIT_OBJECT_BATCH_HEADER_TOO_LARGE");
      }
      await this.readChunk();
    }
  }

  async readExactly(size: number): Promise<Buffer> {
    while (this.buffered.length < size) await this.readChunk();
    const result = this.buffered.subarray(0, size);
    this.buffered = this.buffered.subarray(size);
    return result;
  }

  private async readChunk(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done) {
      throw new GitObjectBatchValidationError("AUTHORITY_GIT_OBJECT_BATCH_HALF_READ");
    }
    this.buffered = this.buffered.length === 0
      ? Buffer.from(next.value)
      : Buffer.concat([this.buffered, Buffer.from(next.value)]);
  }
}

function canonicalGitRoot(rootDir: string): string {
  return realpathSync.native(path.resolve(rootDir));
}

function existingCanonicalGitRoot(rootDir: string): string | undefined {
  try {
    return canonicalGitRoot(rootDir);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function writeBatchRequest(child: ChildProcessWithoutNullStreams, objectName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${objectName}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function refChild(child: ChildProcessWithoutNullStreams): void {
  child.ref();
  refStream(child.stdin);
  refStream(child.stdout);
  refStream(child.stderr);
}

function unrefChild(child: ChildProcessWithoutNullStreams): void {
  child.unref();
  unrefStream(child.stdin);
  unrefStream(child.stdout);
  unrefStream(child.stderr);
}

function refStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (stream as typeof stream & { ref?: () => void }).ref?.();
}

function unrefStream(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (stream as typeof stream & { unref?: () => void }).unref?.();
}

async function ownedProcessTree(rootPid: number): Promise<ReadonlyArray<number>> {
  if (process.platform === "win32") return [rootPid];
  const parentByPid = process.platform === "linux"
    ? readLinuxProcessParents()
    : await readPosixProcessParents();
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parentByPid) {
      if (owned.has(parentPid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return [...owned].sort((left, right) => processDepth(right, parentByPid) - processDepth(left, parentByPid));
}

function readLinuxProcessParents(): ReadonlyMap<number, number> {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(fields[1]));
    } catch {
      // Processes may exit between /proc enumeration and stat reads.
    }
  }
  return parents;
}

async function readPosixProcessParents(): Promise<ReadonlyMap<number, number>> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    windowsHide: true
  });
  const parents = new Map<number, number>();
  for (const line of String(stdout).split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

function processDepth(pid: number, parentByPid: ReadonlyMap<number, number>): number {
  let depth = 0;
  let current = pid;
  const visited = new Set<number>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = parentByPid.get(current);
    if (parent === undefined) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function signalOwnedProcesses(pids: ReadonlyArray<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForOwnedProcessesToClose(
  pids: ReadonlyArray<number>,
  childClosed: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (childClosed() && pids.every((pid) => !isProcessAlive(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return childClosed() && pids.every((pid) => !isProcessAlive(pid));
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  try {
    await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1_000
    });
  } catch (error) {
    throw new Error(
      `AUTHORITY_GIT_OBJECT_BATCH_TASKKILL_FAILED:pid=${pid};failure=${gitObjectReadErrorMessage(error)}`,
      { cause: error }
    );
  }
}

function gitObjectReadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function oneShotGitObject(rootDir: string, objectName: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", rootDir, "show", objectName], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: maximumGitObjectBytes
  });
  return stdout;
}

function reportBatchFailure(
  code: string,
  rootDir: string,
  error: unknown,
  action: string
): void {
  process.emitWarning(
    `${code}:root=${rootDir};failure=${gitObjectReadErrorMessage(error)};${action}`,
    { type: "GitCatFileBatchWarning", code }
  );
}
