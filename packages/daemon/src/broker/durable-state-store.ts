import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ReplicaChangeRecord } from "../../../application/src/index.ts";
import { fingerprintDigest } from "./fingerprint.ts";
import type { BrokerDurableState } from "./types.ts";
import { isMissing } from "./errno.ts";

interface StateEnvelope {
  readonly schema: "broker-state-envelope/v1";
  readonly checksum: string;
  readonly state: BrokerDurableState;
}

export class BrokerDurableStateStore {
  readonly stateRoot: string;
  private readonly dbRoot: string;
  private readonly inboxRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    this.dbRoot = path.join(stateRoot, "db-and-wal");
    this.inboxRoot = path.join(stateRoot, "inbox");
  }

  async initialize(workspaceId: string): Promise<BrokerDurableState> {
    await Promise.all([
      mkdir(this.dbRoot, { recursive: true, mode: 0o700 }),
      mkdir(this.inboxRoot, { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.stateRoot, "cas"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.stateRoot, "conflicts"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(this.stateRoot, "displaced-guards"), { recursive: true, mode: 0o700 })
    ]);
    const existing = await this.load();
    if (existing) {
      if (existing.workspaceId !== workspaceId) throw new Error("broker state belongs to another workspace");
      return existing;
    }
    const state: BrokerDurableState = {
      schema: "broker-state/v1",
      workspaceId,
      epoch: "epoch-1",
      receivedCursor: 0,
      resolvedCursor: 0,
      receivedCommit: null,
      resolvedCommit: null,
      nextJournalLSN: 1,
      mode: "READY",
      paths: {},
      pendingMaterializations: [],
      witnesses: {}
    };
    await this.save(state);
    return state;
  }

  async load(): Promise<BrokerDurableState | undefined> {
    try {
      const envelope = JSON.parse(await readFile(this.statePath(), "utf8")) as StateEnvelope;
      if (envelope.schema !== "broker-state-envelope/v1"
        || envelope.checksum !== fingerprintDigest(envelope.state)
        || envelope.state.schema !== "broker-state/v1") {
        throw new Error("broker state integrity check failed");
      }
      return envelope.state;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async save(state: BrokerDurableState): Promise<void> {
    const envelope: StateEnvelope = {
      schema: "broker-state-envelope/v1",
      checksum: fingerprintDigest(state),
      state
    };
    await atomicWrite(this.statePath(), Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8"));
  }

  async appendInbox(change: ReplicaChangeRecord): Promise<void> {
    const destination = this.inboxPath(change.revision);
    try {
      const existing = JSON.parse(await readFile(destination, "utf8")) as ReplicaChangeRecord;
      if (fingerprintDigest(existing) !== fingerprintDigest(change)) {
        throw new Error(`replica revision ${change.revision} has another event digest`);
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicWrite(destination, Buffer.from(`${JSON.stringify(change)}\n`, "utf8"));
  }

  async readInbox(revision: number): Promise<ReplicaChangeRecord> {
    return JSON.parse(await readFile(this.inboxPath(revision), "utf8")) as ReplicaChangeRecord;
  }

  private statePath(): string {
    return path.join(this.dbRoot, "broker-state.json");
  }

  private inboxPath(revision: number): string {
    return path.join(this.inboxRoot, `${String(revision).padStart(16, "0")}.json`);
  }
}

export async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

