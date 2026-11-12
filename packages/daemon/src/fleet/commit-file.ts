import { JSONParser, TokenType } from "@streamparser/json";
import { openTemporaryFile, type ReplicationCommit, type SqliteEventRow } from "@harness-anything/storage";
import { ReplicationError, validateReplicationCommit } from "./protocol.ts";

/** Transient, replayable rows. Memory is bounded by one event/outcome, not the transaction. */
export function openReplicationCommitFile(file: string, bufferBytes: number) {
  const filePort = openTemporaryFile(file),
    metadata: Record<string, unknown> = {},
    fields = new Set<string>(),
    parser = new JSONParser({
      paths: ["$.position", "$.outcome", "$.writer", "$.events.*"],
      keepStack: false,
      stringBufferSize: bufferBytes,
    });
  let depth = 0,
    key = "",
    expectKey = false,
    expectValue = false,
    eventsArray = false;
  const invalid = () => {
    throw new ReplicationError("invalid replication commit envelope", "replica_protocol_error");
  };
  parser.onToken = ({ token, value }) => {
    if (depth === 0 && token !== TokenType.LEFT_BRACE) invalid();
    if (depth === 1) {
      if (expectKey && token === TokenType.STRING) {
        key = String(value);
        if (!["position", "events", "outcome", "writer"].includes(key) || fields.has(key)) invalid();
        fields.add(key);
        expectKey = false;
      } else if (token === TokenType.COLON) expectValue = true;
      else if (expectValue) {
        if (key === "events") {
          if (token !== TokenType.LEFT_BRACKET) invalid();
          eventsArray = true;
        }
        expectValue = false;
      } else if (token === TokenType.COMMA) expectKey = true;
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      depth++;
      if (depth === 1) expectKey = true;
    } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) depth--;
  };
  parser.onValue = ({ value, stack, key }) => {
    if (stack.length === 2 && stack[1]?.key === "events") {
      const bytes = Buffer.from(JSON.stringify(value)),
        header = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      filePort.write(header);
      filePort.write(bytes);
    } else metadata[String(key)] = value;
  };
  const events: Iterable<SqliteEventRow> = {
    *[Symbol.iterator]() {
      let offset = 0;
      const header = Buffer.alloc(4);
      const readAll = (bytes: Buffer) => {
        let read = 0;
        while (read < bytes.length) {
          const count = filePort.read(bytes.subarray(read), offset);
          if (!count) throw new Error("replication event staging file truncated");
          read += count;
          offset += count;
        }
      };
      while (filePort.read(header, offset)) {
        offset += 4;
        const bytes = Buffer.alloc(header.readUInt32BE());
        readAll(bytes);
        yield JSON.parse(bytes.toString("utf8")) as SqliteEventRow;
      }
    },
  };
  return {
    write: (bytes: Buffer) => {
      try {
        parser.write(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new ReplicationError("invalid replication commit JSON", "replica_protocol_error");
      }
    },
    finish: (): ReplicationCommit<Iterable<SqliteEventRow>> => {
      try {
        if (!parser.isEnded) parser.end();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw error;
        throw new ReplicationError("incomplete replication commit JSON", "replica_protocol_error");
      }
      if (fields.size !== 4 || !eventsArray) invalid();
      const commit = { ...metadata, events };
      validateReplicationCommit(commit);
      return commit;
    },
    close: filePort.close,
  };
}
