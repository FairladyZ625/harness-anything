import { Schema } from "effect";
import { timestamp } from "../domain/timestamp.ts";

export const UtcTimestampSchema = Schema.String.pipe(Schema.filter(timestamp));
