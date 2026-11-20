export const hostCheckpointSource = `import { open, rename, rm, writeFile } from 'node:fs/promises';
export async function writeHostEnvironmentFile() {
  const file = await open('temp','wx');
  await writeFile(file, '{}');
  await rename('temp','pin.json');
  await rm('temp');
}`;
