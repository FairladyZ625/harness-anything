export type RandomInt = (exclusive: number) => number;

export function seededRandom(seed: number): RandomInt {
  let state = seed;
  return (exclusive) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % exclusive;
  };
}

export function* removedChunks(length: number): Iterable<readonly [start: number, end: number]> {
  // Try removing chunks from largest to smallest, including deletion of a single element.
  for (let size = length; size > 0; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= length; start++) {
      yield [start, start + size];
    }
  }
}

function failure<T>(check: (input: T) => void, input: T): Error | undefined {
  try {
    check(input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  return undefined;
}

export function checkProperty<T>(
  generate: (random: RandomInt, index: number) => T,
  check: (input: T) => void,
  shrink: (input: T) => Iterable<T> = () => [],
  runs = 512,
): void {
  const seed = Number(process.env.HARNESS_PROPERTY_SEED ?? 0x5eed1234);
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
    throw new Error("HARNESS_PROPERTY_SEED must be a nonzero unsigned 32-bit integer");
  }

  const random = seededRandom(seed);
  for (let index = 0; index < runs; index++) {
    const input = generate(random, index);
    const cause = failure(check, input);
    if (!cause) continue;

    let smallest = input;
    let shrinks = 0;
    // Restart from the first failing candidate until no supplied reduction still fails.
    for (let next = shrink(smallest); ; next = shrink(smallest)) {
      let reduced = false;
      for (const candidate of next) {
        const error = failure(check, candidate);
        if (error?.name !== cause.name || error.message !== cause.message) continue;
        smallest = candidate;
        shrinks++;
        reduced = true;
        break;
      }
      if (!reduced) break;
    }
    throw new Error(
      `seed=${seed} case=${index + 1} input=${JSON.stringify(input)} shrinks=${shrinks} counterexample=${JSON.stringify(smallest)}`,
      { cause },
    );
  }
}
