// Version 16 adds the rebuildable archived_entity witness table used by genesis
// migration truth-gap restatements. A version mismatch takes the discard-and-replay
// path so an older cache cannot silently omit archived source identities.
export const taskProjectionSchemaVersion = 16;
