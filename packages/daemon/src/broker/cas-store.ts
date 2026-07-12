import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./durable-state-store.ts";
import { fingerprintBytes } from "./fingerprint.ts";
import { isMissing } from "./errno.ts";

export class BrokerCasStore {
  private readonly root: string;

  constructor(stateRoot: string) {
    this.root = path.join(stateRoot, "cas");
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = fingerprintBytes(bytes).blobDigest;
    const destination = this.pathFor(digest);
    try {
      const existing = await readFile(destination);
      if (fingerprintBytes(existing).blobDigest !== digest) throw new Error(`CAS object corrupted: ${digest}`);
      return digest;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await atomicWrite(destination, bytes);
    return digest;
  }

  async get(digest: string): Promise<Buffer> {
    const bytes = await readFile(this.pathFor(digest));
    if (fingerprintBytes(bytes).blobDigest !== digest) throw new Error(`CAS object corrupted: ${digest}`);
    return bytes;
  }

  private pathFor(digest: string): string {
    const key = digest.replace(/^sha256:/u, "");
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error(`invalid CAS digest: ${digest}`);
    return path.join(this.root, key.slice(0, 2), key.slice(2));
  }
}

