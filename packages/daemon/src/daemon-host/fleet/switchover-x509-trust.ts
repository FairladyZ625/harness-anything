import { hash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { fleetEdgeConfigDir, type FleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { FleetFault } from "./center-types.ts";

interface DerTlv {
  readonly tag: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly nextOffset: number;
}

interface DerAva {
  readonly oidHex: string;
  readonly normalizedText: string | null;
  readonly rawTag: number;
  readonly rawValue: Buffer;
}

type DerRdn = readonly DerAva[];
type DerName = readonly DerRdn[];

type NameConstraintSubtree =
  | { readonly kind: "dns"; readonly value: string }
  | { readonly kind: "ip"; readonly bytes: Buffer }
  | { readonly kind: "directory"; readonly rdns: DerName }
  | { readonly kind: "rfc822"; readonly value: string }
  | { readonly kind: "uri"; readonly value: string };

interface ParsedNameConstraints {
  readonly permitted: readonly NameConstraintSubtree[];
  readonly excluded: readonly NameConstraintSubtree[];
}

interface ParsedSubjectAltNames {
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly Buffer[];
  readonly directoryNames: readonly DerName[];
  readonly rfc822Names: readonly string[];
  readonly uris: readonly string[];
}

interface ParsedCertData {
  readonly cert: X509Certificate;
  readonly issuerRdns: DerName;
  readonly subjectRdns: DerName;
  readonly selfIssued: boolean;
  readonly basicConstraintsPresent: boolean;
  readonly basicConstraintsCa: boolean;
  readonly pathLenConstraint: number | null;
  readonly keyUsagePresent: boolean;
  readonly digitalSignature: boolean;
  readonly keyCertSign: boolean;
  readonly nameConstraints: ParsedNameConstraints | null;
  readonly san: ParsedSubjectAltNames;
}

const OID_COMMON_NAME_HEX = "550403"; // 2.5.4.3
const OID_EMAIL_ADDRESS_HEX = "2a864886f70d010901"; // 1.2.840.113549.1.9.1

const OID_BASIC_CONSTRAINTS_HEX = "551d13"; // 2.5.29.19
const OID_KEY_USAGE_HEX = "551d0f"; // 2.5.29.15
const OID_EXT_KEY_USAGE_HEX = "551d25"; // 2.5.29.37
const OID_SUBJECT_ALT_NAME_HEX = "551d11"; // 2.5.29.17
const OID_NAME_CONSTRAINTS_HEX = "551d1e"; // 2.5.29.30
const OID_SUBJECT_KEY_ID_HEX = "551d0e"; // 2.5.29.14
const OID_AUTHORITY_KEY_ID_HEX = "551d23"; // 2.5.29.35
const OID_CERT_POL_EXT_HEX = "551d20"; // 2.5.29.32

const KNOWN_CRITICAL_EXT_OIDS = new Set<string>([
  OID_BASIC_CONSTRAINTS_HEX,
  OID_KEY_USAGE_HEX,
  OID_EXT_KEY_USAGE_HEX,
  OID_SUBJECT_ALT_NAME_HEX,
  OID_NAME_CONSTRAINTS_HEX,
  OID_SUBJECT_KEY_ID_HEX,
  OID_AUTHORITY_KEY_ID_HEX,
  OID_CERT_POL_EXT_HEX,
]);

const EKU_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const EKU_ANY_EXTENDED_KEY_USAGE = "2.5.29.37.0";

export function spkiSha256FromCertificatePem(certPem: string | Buffer): string {
  const x509 = new X509Certificate(certPem);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  return `sha256:${hash("sha256", spkiDer, "hex")}`;
}

function parseCertificateChain(pem: string): readonly X509Certificate[] {
  const matches = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)];
  return matches.map(([block]) => new X509Certificate(block!));
}

function normalizeSpkiDigestHex(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function readDerTlv(buf: Buffer, offset: number, end: number): DerTlv | null {
  if (offset + 2 > end) return null;
  const tag = buf[offset]!;
  const lenByte = buf[offset + 1]!;
  let length = 0;
  let valueStart = offset + 2;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
  } else {
    const octetCount = lenByte & 0x7f;
    if (octetCount === 0 || octetCount > 4 || offset + 2 + octetCount > end) return null;
    for (let i = 0; i < octetCount; i += 1) {
      length = length * 256 + buf[offset + 2 + i]!;
    }
    valueStart = offset + 2 + octetCount;
  }
  const valueEnd = valueStart + length;
  if (valueEnd > end) return null;
  return { tag, valueStart, valueEnd, nextOffset: valueEnd };
}

function parseDerNonNegativeInt(buf: Buffer, start: number, end: number): number | null {
  if (end <= start || (buf[start]! & 0x80) !== 0) return null;
  let parsed = 0;
  for (let i = start; i < end; i += 1) {
    parsed = parsed * 256 + buf[i]!;
    if (!Number.isSafeInteger(parsed)) return null;
  }
  return parsed;
}

function decodeDerString(buf: Buffer, tag: number, start: number, end: number): string | null {
  const slice = buf.subarray(start, end);
  if (tag === 0x0c || tag === 0x13 || tag === 0x16) return slice.toString("utf8");
  if (tag === 0x14) return slice.toString("latin1");
  if (tag === 0x1e) {
    if (slice.length % 2 !== 0) return null;
    const swapped = Buffer.alloc(slice.length);
    for (let i = 0; i < slice.length; i += 2) {
      swapped[i] = slice[i + 1]!;
      swapped[i + 1] = slice[i]!;
    }
    return swapped.toString("utf16le");
  }
  if (tag === 0x1c) {
    if (slice.length % 4 !== 0) return null;
    const cps: number[] = [];
    for (let i = 0; i < slice.length; i += 4) {
      cps.push(slice.readUInt32BE(i));
    }
    return String.fromCodePoint(...cps);
  }
  return null;
}

function normalizeRfc5280String(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

function parseDerName(buf: Buffer, start: number, end: number): DerName | null {
  const rdns: DerRdn[] = [];
  let cursor = start;
  while (cursor < end) {
    const rdnTlv = readDerTlv(buf, cursor, end);
    if (!rdnTlv || rdnTlv.tag !== 0x31) return null;
    cursor = rdnTlv.nextOffset;
    const avas: DerAva[] = [];
    let avaCursor = rdnTlv.valueStart;
    while (avaCursor < rdnTlv.valueEnd) {
      const avaTlv = readDerTlv(buf, avaCursor, rdnTlv.valueEnd);
      if (!avaTlv || avaTlv.tag !== 0x30) return null;
      avaCursor = avaTlv.nextOffset;
      const oidTlv = readDerTlv(buf, avaTlv.valueStart, avaTlv.valueEnd);
      if (!oidTlv || oidTlv.tag !== 0x06) return null;
      const valTlv = readDerTlv(buf, oidTlv.nextOffset, avaTlv.valueEnd);
      if (!valTlv || valTlv.nextOffset !== avaTlv.valueEnd) return null;
      const decoded = decodeDerString(buf, valTlv.tag, valTlv.valueStart, valTlv.valueEnd);
      avas.push({
        oidHex: buf.subarray(oidTlv.valueStart, oidTlv.valueEnd).toString("hex"),
        normalizedText: decoded !== null ? normalizeRfc5280String(decoded) : null,
        rawTag: valTlv.tag,
        rawValue: buf.subarray(valTlv.valueStart, valTlv.valueEnd),
      });
    }
    if (avas.length === 0) return null;
    rdns.push(avas);
  }
  return rdns;
}

function avaEquals(a: DerAva, b: DerAva): boolean {
  if (a.oidHex !== b.oidHex) return false;
  if (a.normalizedText !== null && b.normalizedText !== null) {
    return a.normalizedText === b.normalizedText;
  }
  return a.rawTag === b.rawTag && a.rawValue.equals(b.rawValue);
}

function rdnEquals(a: DerRdn, b: DerRdn): boolean {
  if (a.length !== b.length) return false;
  const matched = new Array<boolean>(b.length).fill(false);
  for (const itemA of a) {
    let found = false;
    for (let j = 0; j < b.length; j += 1) {
      if (!matched[j] && avaEquals(itemA, b[j]!)) {
        matched[j] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function rdnSequenceEquals(a: DerName, b: DerName): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!rdnEquals(a[i]!, b[i]!)) return false;
  }
  return true;
}

function directoryNameMatchesSubtree(candidate: DerName, subtree: DerName): boolean {
  if (candidate.length < subtree.length) return false;
  for (let i = 0; i < subtree.length; i += 1) {
    if (!rdnEquals(candidate[i]!, subtree[i]!)) return false;
  }
  return true;
}

function parseAsciiIa5(buf: Buffer, start: number, end: number): string | null {
  for (let i = start; i < end; i += 1) {
    const byte = buf[i]!;
    if (byte === 0 || byte > 0x7f) return null;
  }
  return buf.subarray(start, end).toString("ascii");
}

function parseSubjectAltNameExt(buf: Buffer, start: number, end: number): ParsedSubjectAltNames | null {
  const seq = readDerTlv(buf, start, end);
  if (!seq || seq.tag !== 0x30 || seq.nextOffset !== end) return null;
  const dnsNames: string[] = [];
  const ipAddresses: Buffer[] = [];
  const directoryNames: DerName[] = [];
  const rfc822Names: string[] = [];
  const uris: string[] = [];
  let cursor = seq.valueStart;
  while (cursor < seq.valueEnd) {
    const gn = readDerTlv(buf, cursor, seq.valueEnd);
    if (!gn) return null;
    cursor = gn.nextOffset;
    if (gn.tag === 0x82) {
      const dns = parseAsciiIa5(buf, gn.valueStart, gn.valueEnd);
      if (dns === null) return null;
      dnsNames.push(dns);
    } else if (gn.tag === 0x87) {
      const ipLen = gn.valueEnd - gn.valueStart;
      if (ipLen !== 4 && ipLen !== 16) return null;
      ipAddresses.push(buf.subarray(gn.valueStart, gn.valueEnd));
    } else if (gn.tag === 0xa4) {
      const nameSeq = readDerTlv(buf, gn.valueStart, gn.valueEnd);
      if (!nameSeq || nameSeq.tag !== 0x30 || nameSeq.nextOffset !== gn.valueEnd) return null;
      const parsed = parseDerName(buf, nameSeq.valueStart, nameSeq.valueEnd);
      if (!parsed) return null;
      directoryNames.push(parsed);
    } else if (gn.tag === 0x81) {
      const mail = parseAsciiIa5(buf, gn.valueStart, gn.valueEnd);
      if (mail === null) return null;
      rfc822Names.push(mail);
    } else if (gn.tag === 0x86) {
      const uri = parseAsciiIa5(buf, gn.valueStart, gn.valueEnd);
      if (uri === null) return null;
      uris.push(uri);
    }
  }
  return { dnsNames, ipAddresses, directoryNames, rfc822Names, uris };
}

function parseGeneralSubtrees(buf: Buffer, start: number, end: number): readonly NameConstraintSubtree[] | null {
  const subtrees: NameConstraintSubtree[] = [];
  let cursor = start;
  while (cursor < end) {
    const st = readDerTlv(buf, cursor, end);
    if (!st || st.tag !== 0x30) return null;
    cursor = st.nextOffset;
    const base = readDerTlv(buf, st.valueStart, st.valueEnd);
    if (!base) return null;
    let entry: NameConstraintSubtree;
    if (base.tag === 0x82) {
      const dns = parseAsciiIa5(buf, base.valueStart, base.valueEnd);
      if (dns === null) return null;
      entry = { kind: "dns", value: dns };
    } else if (base.tag === 0x87) {
      const ipLen = base.valueEnd - base.valueStart;
      if (ipLen !== 8 && ipLen !== 32) return null;
      entry = { kind: "ip", bytes: buf.subarray(base.valueStart, base.valueEnd) };
    } else if (base.tag === 0xa4) {
      const nameSeq = readDerTlv(buf, base.valueStart, base.valueEnd);
      if (!nameSeq || nameSeq.tag !== 0x30 || nameSeq.nextOffset !== base.valueEnd) return null;
      const parsed = parseDerName(buf, nameSeq.valueStart, nameSeq.valueEnd);
      if (!parsed) return null;
      entry = { kind: "directory", rdns: parsed };
    } else if (base.tag === 0x81) {
      const mail = parseAsciiIa5(buf, base.valueStart, base.valueEnd);
      if (mail === null) return null;
      entry = { kind: "rfc822", value: mail };
    } else if (base.tag === 0x86) {
      const uri = parseAsciiIa5(buf, base.valueStart, base.valueEnd);
      if (uri === null) return null;
      entry = { kind: "uri", value: uri };
    } else {
      // Fail closed on any unsupported GeneralName tag (RFC 5280 §4.2.1.10).
      return null;
    }
    let stCursor = base.nextOffset;
    let seenMin = false;
    while (stCursor < st.valueEnd) {
      const opt = readDerTlv(buf, stCursor, st.valueEnd);
      if (!opt) return null;
      stCursor = opt.nextOffset;
      if (opt.tag === 0x80 && !seenMin) {
        seenMin = true;
        const minVal = parseDerNonNegativeInt(buf, opt.valueStart, opt.valueEnd);
        if (minVal === null || minVal !== 0) return null;
      } else {
        // Reject present maximum [1] (0x81), duplicate minimum, or unknown fields.
        return null;
      }
    }
    subtrees.push(entry);
  }
  return subtrees.length > 0 ? subtrees : null;
}

function parseNameConstraintsExt(buf: Buffer, start: number, end: number): ParsedNameConstraints | null {
  const seq = readDerTlv(buf, start, end);
  if (!seq || seq.tag !== 0x30 || seq.nextOffset !== end) return null;
  let permitted: readonly NameConstraintSubtree[] | null = null;
  let excluded: readonly NameConstraintSubtree[] | null = null;
  let cursor = seq.valueStart;
  while (cursor < seq.valueEnd) {
    const field = readDerTlv(buf, cursor, seq.valueEnd);
    if (!field) return null;
    cursor = field.nextOffset;
    if (field.tag === 0xa0 && permitted === null && excluded === null) {
      permitted = parseGeneralSubtrees(buf, field.valueStart, field.valueEnd);
      if (!permitted) return null;
    } else if (field.tag === 0xa1 && excluded === null) {
      excluded = parseGeneralSubtrees(buf, field.valueStart, field.valueEnd);
      if (!excluded) return null;
    } else {
      return null;
    }
  }
  if (permitted === null && excluded === null) return null;
  return { permitted: permitted ?? [], excluded: excluded ?? [] };
}

function extractCertData(cert: X509Certificate): ParsedCertData | null {
  const raw = cert.raw;
  const outer = readDerTlv(raw, 0, raw.length);
  if (!outer || outer.tag !== 0x30 || outer.nextOffset !== raw.length) return null;
  const tbs = readDerTlv(raw, outer.valueStart, outer.valueEnd);
  if (!tbs || tbs.tag !== 0x30) return null;
  let cursor = tbs.valueStart;
  let field = readDerTlv(raw, cursor, tbs.valueEnd);
  if (!field) return null;
  if (field.tag === 0xa0) {
    cursor = field.nextOffset;
    field = readDerTlv(raw, cursor, tbs.valueEnd);
    if (!field) return null;
  }
  // serialNumber (0x02)
  if (field.tag !== 0x02) return null;
  // signature AlgorithmIdentifier (0x30)
  const sigAlg = readDerTlv(raw, field.nextOffset, tbs.valueEnd);
  if (!sigAlg || sigAlg.tag !== 0x30) return null;
  // issuer Name (0x30)
  const issuerTlv = readDerTlv(raw, sigAlg.nextOffset, tbs.valueEnd);
  if (!issuerTlv || issuerTlv.tag !== 0x30) return null;
  const issuerRdns = parseDerName(raw, issuerTlv.valueStart, issuerTlv.valueEnd);
  if (!issuerRdns) return null;
  // validity (0x30)
  const validityTlv = readDerTlv(raw, issuerTlv.nextOffset, tbs.valueEnd);
  if (!validityTlv || validityTlv.tag !== 0x30) return null;
  // subject Name (0x30)
  const subjectTlv = readDerTlv(raw, validityTlv.nextOffset, tbs.valueEnd);
  if (!subjectTlv || subjectTlv.tag !== 0x30) return null;
  const subjectRdns = parseDerName(raw, subjectTlv.valueStart, subjectTlv.valueEnd);
  if (!subjectRdns) return null;
  // subjectPublicKeyInfo (0x30)
  const spkiTlv = readDerTlv(raw, subjectTlv.nextOffset, tbs.valueEnd);
  if (!spkiTlv || spkiTlv.tag !== 0x30) return null;

  let extWrapper: DerTlv | null = null;
  cursor = spkiTlv.nextOffset;
  while (cursor < tbs.valueEnd) {
    const trailing = readDerTlv(raw, cursor, tbs.valueEnd);
    if (!trailing) return null;
    if (trailing.tag === 0xa3) {
      if (extWrapper !== null) return null;
      extWrapper = trailing;
    }
    cursor = trailing.nextOffset;
  }

  let basicConstraintsPresent = false;
  let basicConstraintsCa = false;
  let pathLenConstraint: number | null = null;
  let keyUsagePresent = false;
  let digitalSignature = false;
  let keyCertSign = false;
  let nameConstraints: ParsedNameConstraints | null = null;
  let san: ParsedSubjectAltNames = {
    dnsNames: [],
    ipAddresses: [],
    directoryNames: [],
    rfc822Names: [],
    uris: [],
  };

  if (extWrapper) {
    const extSeq = readDerTlv(raw, extWrapper.valueStart, extWrapper.valueEnd);
    if (!extSeq || extSeq.tag !== 0x30 || extSeq.nextOffset !== extWrapper.valueEnd) return null;
    const seenOids = new Set<string>();
    let extCursor = extSeq.valueStart;
    while (extCursor < extSeq.valueEnd) {
      const ext = readDerTlv(raw, extCursor, extSeq.valueEnd);
      if (!ext || ext.tag !== 0x30) return null;
      extCursor = ext.nextOffset;
      const oid = readDerTlv(raw, ext.valueStart, ext.valueEnd);
      if (!oid || oid.tag !== 0x06) return null;
      const afterOid = readDerTlv(raw, oid.nextOffset, ext.valueEnd);
      if (!afterOid) return null;
      let critical = false;
      let extnVal: DerTlv | null;
      if (afterOid.tag === 0x01) {
        if (afterOid.valueEnd - afterOid.valueStart !== 1) return null;
        critical = raw[afterOid.valueStart]! !== 0;
        extnVal = readDerTlv(raw, afterOid.nextOffset, ext.valueEnd);
      } else {
        extnVal = afterOid;
      }
      if (!extnVal || extnVal.tag !== 0x04 || extnVal.nextOffset !== ext.valueEnd) return null;
      const oidHex = raw.subarray(oid.valueStart, oid.valueEnd).toString("hex");
      if (seenOids.has(oidHex)) return null;
      seenOids.add(oidHex);
      if (critical && !KNOWN_CRITICAL_EXT_OIDS.has(oidHex)) {
        // Fail closed on any unrecognized critical extension (RFC 5280 §6.1.3(a)(3)).
        return null;
      }
      if (oidHex === OID_BASIC_CONSTRAINTS_HEX) {
        basicConstraintsPresent = true;
        const bcSeq = readDerTlv(raw, extnVal.valueStart, extnVal.valueEnd);
        if (!bcSeq || bcSeq.tag !== 0x30 || bcSeq.nextOffset !== extnVal.valueEnd) return null;
        let bcCursor = bcSeq.valueStart;
        if (bcCursor < bcSeq.valueEnd) {
          const first = readDerTlv(raw, bcCursor, bcSeq.valueEnd);
          if (!first) return null;
          if (first.tag === 0x01) {
            if (first.valueEnd - first.valueStart !== 1) return null;
            basicConstraintsCa = raw[first.valueStart]! !== 0;
            bcCursor = first.nextOffset;
          }
        }
        if (bcCursor < bcSeq.valueEnd) {
          const pathInt = readDerTlv(raw, bcCursor, bcSeq.valueEnd);
          if (!pathInt || pathInt.tag !== 0x02 || pathInt.nextOffset !== bcSeq.valueEnd) return null;
          const parsedPathLen = parseDerNonNegativeInt(raw, pathInt.valueStart, pathInt.valueEnd);
          if (parsedPathLen === null) return null;
          pathLenConstraint = parsedPathLen;
        }
        if (!basicConstraintsCa && pathLenConstraint !== null) return null;
      } else if (oidHex === OID_KEY_USAGE_HEX) {
        keyUsagePresent = true;
        const kuBits = readDerTlv(raw, extnVal.valueStart, extnVal.valueEnd);
        if (!kuBits || kuBits.tag !== 0x03 || kuBits.nextOffset !== extnVal.valueEnd) return null;
        const bitPayloadLen = kuBits.valueEnd - kuBits.valueStart;
        if (bitPayloadLen < 1) return null;
        const unusedBits = raw[kuBits.valueStart]!;
        if (unusedBits > 7 || (bitPayloadLen === 1 && unusedBits !== 0)) return null;
        const totalBits = (bitPayloadLen - 1) * 8 - unusedBits;
        const bitAt = (idx: number): boolean =>
          idx < totalBits && (raw[kuBits.valueStart + 1 + (idx >> 3)]! & (0x80 >> (idx & 7))) !== 0;
        digitalSignature = bitAt(0);
        keyCertSign = bitAt(5);
      } else if (oidHex === OID_SUBJECT_ALT_NAME_HEX) {
        const parsedSan = parseSubjectAltNameExt(raw, extnVal.valueStart, extnVal.valueEnd);
        if (!parsedSan) return null;
        san = parsedSan;
      } else if (oidHex === OID_NAME_CONSTRAINTS_HEX) {
        const parsedNc = parseNameConstraintsExt(raw, extnVal.valueStart, extnVal.valueEnd);
        if (!parsedNc) return null;
        nameConstraints = parsedNc;
      }
    }
  }

  return {
    cert,
    issuerRdns,
    subjectRdns,
    selfIssued: rdnSequenceEquals(issuerRdns, subjectRdns),
    basicConstraintsPresent,
    basicConstraintsCa,
    pathLenConstraint,
    keyUsagePresent,
    digitalSignature,
    keyCertSign,
    nameConstraints,
    san,
  };
}

function dnsMatchesSubtree(candidate: string, constraint: string, forExcluded: boolean): boolean {
  const cand = candidate.toLowerCase();
  const cons = constraint.toLowerCase();
  if (cons.length === 0) return true;
  if (cons.startsWith(".")) {
    if (cand.length > cons.length && cand.endsWith(cons)) return true;
  } else if (cand === cons || cand.endsWith(`.${cons}`)) {
    return true;
  }
  if (forExcluded && cand.startsWith("*.")) {
    const suffix = cand.slice(1);
    if (cons.length > suffix.length && cons.endsWith(suffix)) return true;
    if (cons === suffix) return true;
  }
  return false;
}

function ipMatchesSubtree(candidate: Buffer, constraint: Buffer): boolean {
  if (candidate.length * 2 !== constraint.length) return false;
  const half = candidate.length;
  for (let i = 0; i < half; i += 1) {
    const mask = constraint[half + i]!;
    if ((candidate[i]! & mask) !== (constraint[i]! & mask)) return false;
  }
  return true;
}

function rfc822MatchesSubtree(candidate: string, constraint: string): boolean {
  const atIdx = candidate.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === candidate.length - 1) return false;
  const candLocal = candidate.slice(0, atIdx);
  const candDomain = candidate.slice(atIdx + 1).toLowerCase();
  const consAt = constraint.lastIndexOf("@");
  if (consAt >= 0) {
    const consLocal = constraint.slice(0, consAt);
    const consDomain = constraint.slice(consAt + 1).toLowerCase();
    return candLocal === consLocal && candDomain === consDomain;
  }
  const consDomain = constraint.toLowerCase();
  if (consDomain.startsWith(".")) {
    return candDomain.length > consDomain.length && candDomain.endsWith(consDomain);
  }
  return candDomain === consDomain;
}

const DNS_FQDN_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?![0-9]+$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const DNS_WILDCARD_OR_FQDN_RE =
  /^(?:\*|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.(?![0-9]+$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const URI_AUTHORITY_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

function extractConstrainedUriHost(candidate: string): string | null {
  if (!URI_AUTHORITY_SCHEME_RE.test(candidate)) return null;
  const parsed = URL.parse(candidate);
  if (!parsed) return null;
  const rawHost = parsed.hostname;
  if (!rawHost || rawHost.startsWith("[") || rawHost.endsWith("]") || isIP(rawHost) !== 0) return null;
  const normalizedHost = rawHost.endsWith(".") ? rawHost.slice(0, -1) : rawHost;
  if (normalizedHost.length > 253 || !DNS_FQDN_RE.test(normalizedHost)) return null;
  return normalizedHost.toLowerCase();
}

function uriHostMatchesSubtree(host: string, constraint: string): boolean {
  const cons = constraint.toLowerCase();
  if (cons.startsWith(".")) {
    return host.length > cons.length && host.endsWith(cons);
  }
  return host === cons;
}

function extractSubjectAttrTexts(rdns: DerName, oidHex: string): readonly string[] {
  const values: string[] = [];
  for (const rdn of rdns) {
    for (const ava of rdn) {
      if (ava.oidHex !== oidHex) continue;
      const rawText = decodeDerString(ava.rawValue, ava.rawTag, 0, ava.rawValue.length);
      if (rawText !== null && rawText.length > 0) values.push(rawText);
    }
  }
  return values;
}

function certSatisfiesNameConstraints(sub: ParsedCertData, isLeaf: boolean, nc: ParsedNameConstraints): boolean {
  // dNSName (+ CN-to-DNS fallback on leaf when no DNS SAN is present, matching OpenSSL cn2dnsid v3_ncons.c:316-440)
  const dnsCandidates: string[] = [...sub.san.dnsNames];
  if (isLeaf && dnsCandidates.length === 0) {
    for (const cn of extractSubjectAttrTexts(sub.subjectRdns, OID_COMMON_NAME_HEX)) {
      if (cn.length <= 253 && isIP(cn) === 0 && DNS_WILDCARD_OR_FQDN_RE.test(cn)) dnsCandidates.push(cn);
    }
  }
  const permDns = nc.permitted.filter((s): s is Extract<NameConstraintSubtree, { kind: "dns" }> => s.kind === "dns");
  const exclDns = nc.excluded.filter((s): s is Extract<NameConstraintSubtree, { kind: "dns" }> => s.kind === "dns");
  for (const cand of dnsCandidates) {
    if (permDns.length > 0 && !permDns.some((s) => dnsMatchesSubtree(cand, s.value, false))) return false;
    if (exclDns.some((s) => dnsMatchesSubtree(cand, s.value, true))) return false;
  }

  // iPAddress (IPv4 8-byte & IPv6 32-byte addr+mask)
  const permIp = nc.permitted.filter((s): s is Extract<NameConstraintSubtree, { kind: "ip" }> => s.kind === "ip");
  const exclIp = nc.excluded.filter((s): s is Extract<NameConstraintSubtree, { kind: "ip" }> => s.kind === "ip");
  for (const cand of sub.san.ipAddresses) {
    if (permIp.length > 0 && !permIp.some((s) => ipMatchesSubtree(cand, s.bytes))) return false;
    if (exclIp.some((s) => ipMatchesSubtree(cand, s.bytes))) return false;
  }

  // directoryName (non-empty Subject DN + any SAN directoryNames)
  const dirCandidates: DerName[] = [...sub.san.directoryNames];
  if (sub.subjectRdns.length > 0) dirCandidates.push(sub.subjectRdns);
  const permDir = nc.permitted.filter(
    (s): s is Extract<NameConstraintSubtree, { kind: "directory" }> => s.kind === "directory",
  );
  const exclDir = nc.excluded.filter(
    (s): s is Extract<NameConstraintSubtree, { kind: "directory" }> => s.kind === "directory",
  );
  for (const cand of dirCandidates) {
    if (permDir.length > 0 && !permDir.some((s) => directoryNameMatchesSubtree(cand, s.rdns))) return false;
    if (exclDir.some((s) => directoryNameMatchesSubtree(cand, s.rdns))) return false;
  }

  // rfc822Name: check ALL rfc822Name SANs AND all Subject DN emailAddress attributes (OpenSSL v3_ncons.c:257-312).
  const rfc822Candidates: string[] = [
    ...sub.san.rfc822Names,
    ...extractSubjectAttrTexts(sub.subjectRdns, OID_EMAIL_ADDRESS_HEX),
  ];
  const permMail = nc.permitted.filter(
    (s): s is Extract<NameConstraintSubtree, { kind: "rfc822" }> => s.kind === "rfc822",
  );
  const exclMail = nc.excluded.filter(
    (s): s is Extract<NameConstraintSubtree, { kind: "rfc822" }> => s.kind === "rfc822",
  );
  if (permMail.length > 0 || exclMail.length > 0) {
    for (const cand of rfc822Candidates) {
      const atIdx = cand.lastIndexOf("@");
      if (atIdx <= 0 || atIdx === cand.length - 1) return false;
      if (permMail.length > 0 && !permMail.some((s) => rfc822MatchesSubtree(cand, s.value))) return false;
      if (exclMail.some((s) => rfc822MatchesSubtree(cand, s.value))) return false;
    }
  }

  // uniformResourceIdentifier (RFC 5280 §4.2.1.10: authority URI with non-IP FQDN host required whenever constrained)
  const permUri = nc.permitted.filter((s): s is Extract<NameConstraintSubtree, { kind: "uri" }> => s.kind === "uri");
  const exclUri = nc.excluded.filter((s): s is Extract<NameConstraintSubtree, { kind: "uri" }> => s.kind === "uri");
  if (permUri.length > 0 || exclUri.length > 0) {
    for (const cand of sub.san.uris) {
      const uriHost = extractConstrainedUriHost(cand);
      if (uriHost === null) return false;
      if (permUri.length > 0 && !permUri.some((s) => uriHostMatchesSubtree(uriHost, s.value))) return false;
      if (exclUri.some((s) => uriHostMatchesSubtree(uriHost, s.value))) return false;
    }
  }

  return true;
}

function pathSatisfiesNameConstraints(rootToLeaf: readonly ParsedCertData[]): boolean {
  const leafIndex = rootToLeaf.length - 1;
  for (let caIdx = 0; caIdx < leafIndex; caIdx += 1) {
    const nc = rootToLeaf[caIdx]!.nameConstraints;
    if (!nc) continue;
    for (let subIdx = caIdx + 1; subIdx <= leafIndex; subIdx += 1) {
      const sub = rootToLeaf[subIdx]!;
      const isLeaf = subIdx === leafIndex;
      // RFC 5280 §6.1.3(b)-(c): skip self-issued intermediate certificates.
      if (!isLeaf && sub.selfIssued) continue;
      if (!certSatisfiesNameConstraints(sub, isLeaf, nc)) return false;
    }
  }
  return true;
}

function certWithinWindow(cert: X509Certificate, nowMs: number): boolean {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  return Number.isFinite(from) && Number.isFinite(to) && nowMs >= from && nowMs <= to;
}

function caCertPermitsIssuance(
  issuerData: ParsedCertData,
  nonSelfIssuedIntermediatesBelow: number,
  mustHaveBasicConstraints: boolean,
  nowMs: number,
): boolean {
  const { cert } = issuerData;
  if (!certWithinWindow(cert, nowMs)) return false;
  if (mustHaveBasicConstraints) {
    if (!cert.ca || !issuerData.basicConstraintsPresent || !issuerData.basicConstraintsCa) return false;
  } else if (issuerData.basicConstraintsPresent && (!cert.ca || !issuerData.basicConstraintsCa)) {
    return false;
  }
  if (issuerData.keyUsagePresent && !issuerData.keyCertSign) return false;
  if (
    Array.isArray(cert.keyUsage) &&
    cert.keyUsage.length > 0 &&
    !cert.keyUsage.includes(EKU_SERVER_AUTH) &&
    !cert.keyUsage.includes(EKU_ANY_EXTENDED_KEY_USAGE)
  ) {
    return false;
  }
  if (issuerData.pathLenConstraint !== null && nonSelfIssuedIntermediatesBelow > issuerData.pathLenConstraint) {
    return false;
  }
  return true;
}

function chainReachesTrustAnchor(
  leafData: ParsedCertData,
  intermediates: readonly X509Certificate[],
  anchors: readonly X509Certificate[],
  nowMs: number,
): boolean {
  const maxChainDepth = 8;
  const parsedCache = new Map<string, ParsedCertData | null>([[leafData.cert.fingerprint256, leafData]]);
  const getParsed = (cert: X509Certificate): ParsedCertData | null => {
    const key = cert.fingerprint256;
    if (parsedCache.has(key)) return parsedCache.get(key) ?? null;
    const parsed = extractCertData(cert);
    parsedCache.set(key, parsed);
    return parsed;
  };
  const walk = (
    currentData: ParsedCertData,
    depth: number,
    nonSelfIssuedIntermediatesBelow: number,
    pathVisited: ReadonlySet<string>,
    leafToCurrent: readonly ParsedCertData[],
  ): boolean => {
    const current = currentData.cert;
    for (const anchor of anchors) {
      if (!certWithinWindow(anchor, nowMs)) continue;
      if (current.raw.equals(anchor.raw)) {
        const rootToLeaf = [...leafToCurrent].reverse();
        if (pathSatisfiesNameConstraints(rootToLeaf)) return true;
        continue;
      }
      const anchorData = getParsed(anchor);
      if (!anchorData) continue;
      if (
        caCertPermitsIssuance(anchorData, nonSelfIssuedIntermediatesBelow, false, nowMs) &&
        current.checkIssued(anchor) &&
        current.verify(anchor.publicKey)
      ) {
        const rootToLeaf = [...leafToCurrent, anchorData].reverse();
        if (pathSatisfiesNameConstraints(rootToLeaf)) return true;
      }
    }
    if (depth >= maxChainDepth) return false;
    for (const issuer of intermediates) {
      if (pathVisited.has(issuer.fingerprint256)) continue;
      const issuerData = getParsed(issuer);
      if (!issuerData) continue;
      if (!caCertPermitsIssuance(issuerData, nonSelfIssuedIntermediatesBelow, true, nowMs)) continue;
      if (current.checkIssued(issuer) && current.verify(issuer.publicKey)) {
        const nextIntermediates = nonSelfIssuedIntermediatesBelow + (issuerData.selfIssued ? 0 : 1);
        const nextVisited = new Set(pathVisited);
        nextVisited.add(issuer.fingerprint256);
        if (walk(issuerData, depth + 1, nextIntermediates, nextVisited, [...leafToCurrent, issuerData])) return true;
      }
    }
    return false;
  };
  return walk(leafData, 0, 0, new Set<string>([leafData.cert.fingerprint256]), [leafData]);
}

/** Verify an X.509 leaf+intermediate PEM chain against an anchor bundle with full RFC 5280 path & nameConstraints checks. */
export function verifyCertificateChainAgainstAnchors(input: {
  readonly presentedChainPem: string;
  readonly anchorBundlePem: string;
  readonly nowMs?: number;
}): boolean {
  const presented = parseCertificateChain(input.presentedChainPem);
  const anchors = parseCertificateChain(input.anchorBundlePem);
  const leaf = presented[0];
  if (!leaf || anchors.length === 0) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (!certWithinWindow(leaf, nowMs)) return false;
  const leafData = extractCertData(leaf);
  if (!leafData) return false;
  if (leafData.keyUsagePresent && !leafData.digitalSignature) return false;
  if (Array.isArray(leaf.keyUsage) && leaf.keyUsage.length > 0 && !leaf.keyUsage.includes(EKU_SERVER_AUTH)) {
    return false;
  }
  return chainReachesTrustAnchor(leafData, presented.slice(1), anchors, nowMs);
}

/** F8: Verify source Fleet certificate chain (RFC 5280 basicConstraints/pathLenConstraint/keyUsage/EKU/nameConstraints/critical extensions/validity, hostname/IP SAN, SPKI pin, trust anchor). */
export function verifySwitchoverSourceCertificateTrust(input: {
  readonly sourceCertificatePem: string;
  readonly edge: FleetEdgeConfig;
  readonly userRoot: string;
  readonly repoId: string;
}): X509Certificate {
  const { edge } = input;
  const reject = (detail: string): never => {
    throw new FleetFault("switchover_ceded_proof_invalid", detail);
  };
  let presentedChain: readonly X509Certificate[];
  try {
    presentedChain = parseCertificateChain(input.sourceCertificatePem);
  } catch (error) {
    throw new FleetFault(
      "switchover_ceded_proof_invalid",
      `Switchover ceded proof carries an unreadable source certificate: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const sourceCert = presentedChain[0];
  if (!sourceCert) {
    reject("Switchover ceded proof carries no X.509 source certificate.");
  }
  const nowMs = Date.now();
  if (!certWithinWindow(sourceCert!, nowMs)) {
    reject("Switchover ceded proof source certificate is outside its validity window.");
  }
  const leafData = extractCertData(sourceCert!);
  if (!leafData) {
    reject(
      "Switchover ceded proof source certificate carries malformed X.509 extensions or an unrecognized critical extension.",
    );
  }
  if (leafData!.keyUsagePresent && !leafData!.digitalSignature) {
    reject("Switchover ceded proof source certificate keyUsage does not permit digitalSignature.");
  }
  if (
    Array.isArray(sourceCert!.keyUsage) &&
    sourceCert!.keyUsage.length > 0 &&
    !sourceCert!.keyUsage.includes(EKU_SERVER_AUTH)
  ) {
    reject("Switchover ceded proof source certificate extendedKeyUsage does not permit TLS serverAuth.");
  }
  const sourceSpki = normalizeSpkiDigestHex(spkiSha256FromCertificatePem(sourceCert!.toString()));
  if (edge.spkiSha256 && sourceSpki !== normalizeSpkiDigestHex(edge.spkiSha256)) {
    reject(
      "Switchover ceded proof source certificate SPKI does not match this repository's configured center authority.",
    );
  }
  const expectedHost = (edge.servername ?? edge.host).replace(/^\[|\]$/gu, "");
  const hostMatched =
    isIP(expectedHost) !== 0
      ? sourceCert!.checkIP(expectedHost) !== undefined
      : sourceCert!.checkHost(expectedHost) !== undefined;
  if (!hostMatched) {
    reject(`Switchover ceded proof source certificate does not match configured center host ${expectedHost}.`);
  }
  if (edge.spkiPinOnly === true && Boolean(edge.spkiSha256)) {
    return sourceCert!;
  }
  const caPath = path.isAbsolute(edge.caPath)
    ? edge.caPath
    : path.resolve(fleetEdgeConfigDir(input.userRoot, input.repoId), edge.caPath);
  if (!localRuntimeStateFileSystem.exists(caPath)) {
    reject("Configured source center CA bundle is unavailable to verify switchover ceded proof.");
  }
  let trustedAnchors: readonly X509Certificate[];
  try {
    trustedAnchors = parseCertificateChain(readFileSync(caPath, "utf8"));
  } catch (error) {
    throw new FleetFault(
      "switchover_ceded_proof_invalid",
      `Configured source center CA bundle is unreadable: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (
    trustedAnchors.length === 0 ||
    !chainReachesTrustAnchor(leafData!, presentedChain.slice(1), trustedAnchors, nowMs)
  ) {
    reject("Switchover ceded proof source certificate chain is not trusted by this repository's configured center CA.");
  }
  return sourceCert!;
}
