export function validateContentRange(offset: number, maxBytes: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError("content object range must have a non-negative offset and positive maxBytes");
}
