export type WriteIntegrityDomain = "authority" | "legacy";

type IntegrityDomainMember = { readonly authorityIntegrity?: unknown };

export function writeIntegrityDomain(member: IntegrityDomainMember): WriteIntegrityDomain {
  return member.authorityIntegrity === undefined ? "legacy" : "authority";
}

export function singleWriteIntegrityDomain(
  members: ReadonlyArray<IntegrityDomainMember>
): WriteIntegrityDomain | undefined {
  const first = members[0];
  if (!first) return undefined;
  const domain = writeIntegrityDomain(first);
  return members.every((member) => writeIntegrityDomain(member) === domain) ? domain : undefined;
}

export function writeIntegrityDomainsInOrder(
  members: ReadonlyArray<IntegrityDomainMember>
): ReadonlyArray<WriteIntegrityDomain> {
  const domains = new Set<WriteIntegrityDomain>();
  for (const member of members) {
    domains.add(writeIntegrityDomain(member));
  }
  return [...domains];
}

export function recordsForWriteIntegrityDomain<Member extends IntegrityDomainMember>(
  members: ReadonlyArray<Member>,
  domain: WriteIntegrityDomain | undefined
): ReadonlyArray<Member> {
  return domain ? members.filter((member) => writeIntegrityDomain(member) === domain) : members;
}
