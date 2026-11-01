const writer = socket;
const stringifyReply = (value: unknown) => JSON.stringify(value);

writer.write(`${JSON.stringify(reply)}\n`);
writer.write(stringifyReply(reply));
