const originalWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, encoding, callback) => {
  setTimeout(() => originalWrite(chunk, encoding, callback), 10);
  return false;
};
