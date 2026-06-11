export const packageDispositions = [
  "active",
  "archived",
  "tombstoned"
] as const;

export type PackageDisposition = typeof packageDispositions[number];

export function isPackageDisposition(value: string): value is PackageDisposition {
  return (packageDispositions as ReadonlyArray<string>).includes(value);
}
