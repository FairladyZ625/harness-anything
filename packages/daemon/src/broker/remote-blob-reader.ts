import type { AuthoritySnapshotManifestEntry, AuthoritySnapshotReservation } from "../authority/protocol.ts";
import type { PersistentSshAuthorityClient } from "../transport/persistent-ssh-authority-client.ts";
import type { BrokerCasStore } from "./cas-store.ts";
import { isMissing } from "./errno.ts";

export class RemoteBlobReader {
  private readonly flights = new Map<string, Promise<Buffer>>();
  private readonly cas: BrokerCasStore;
  private readonly client: PersistentSshAuthorityClient;
  private readonly assertOpen: () => void;

  constructor(
    cas: BrokerCasStore,
    client: PersistentSshAuthorityClient,
    assertOpen: () => void
  ) {
    this.cas = cas;
    this.client = client;
    this.assertOpen = assertOpen;
  }

  read(
    reservation: AuthoritySnapshotReservation,
    digest: AuthoritySnapshotManifestEntry["blobDigest"]
  ): Promise<Buffer> {
    const existing = this.flights.get(digest);
    if (existing) return existing;
    const flight = this.load(reservation, digest);
    this.flights.set(digest, flight);
    void flight.then(
      () => this.deleteFlight(digest, flight),
      () => this.deleteFlight(digest, flight)
    );
    return flight;
  }

  pending(): ReadonlyArray<Promise<Buffer>> {
    return [...this.flights.values()];
  }

  private async load(
    reservation: AuthoritySnapshotReservation,
    digest: AuthoritySnapshotManifestEntry["blobDigest"]
  ): Promise<Buffer> {
    try {
      return await this.cas.get(digest);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.assertOpen();
    const bytes = await this.client.getBlob(reservation.stream.streamToken, digest);
    this.assertOpen();
    const actual = await this.cas.put(bytes);
    if (actual !== digest) throw new Error(`BLOB_DIGEST_MISMATCH:${digest}:${actual}`);
    return Buffer.from(bytes);
  }

  private deleteFlight(digest: string, flight: Promise<Buffer>): void {
    if (this.flights.get(digest) === flight) this.flights.delete(digest);
  }
}
