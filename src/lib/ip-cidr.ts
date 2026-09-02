/** IPv4 CIDR / exact-IP matching for merchant API allowlists. */

/** Strip IPv6-mapped form and :port so Node/proxy client IPs still match. */
function normalizeIpv4Candidate(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped?.[1]) return mapped[1];
  const ported = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ported?.[1]) return ported[1];
  return s;
}

function ipv4ToInt(ip: string): number | null {
  const parts = normalizeIpv4Candidate(ip).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = ((n << 8) + octet) >>> 0;
  }
  return n;
}

function parseCidr(entry: string): { base: number; mask: number } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) {
    const ip = ipv4ToInt(trimmed);
    if (ip === null) return null;
    return { base: ip, mask: 0xffffffff >>> 0 };
  }
  const [ipPart, prefixPart] = trimmed.split("/");
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const ip = ipv4ToInt(ipPart ?? "");
  if (ip === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, mask };
}

export function normalizeCidrList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function validateCidrList(cidrs: string[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const c of cidrs) {
    if (!parseCidr(c)) {
      errors.push(`Invalid CIDR or IPv4: ${c}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function isIpv4Allowed(clientIp: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  const client = ipv4ToInt(clientIp);
  if (client === null) return false;
  for (const entry of cidrs) {
    const cidr = parseCidr(entry);
    if (!cidr) continue;
    // JS bitwise is signed 32-bit; compare unsigned so 128.0.0.0–255.x still match.
    if (((client & cidr.mask) >>> 0) === cidr.base) return true;
  }
  return false;
}

/** Strip a "[...]" bracket wrapper and zone id so socket/header IPv6 strings still match. */
function normalizeIpv6Candidate(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zoneIdx = s.indexOf("%");
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx);
  return s;
}

function ipv6ToBigInt(raw: string): bigint | null {
  let addr = normalizeIpv6Candidate(raw);
  if (!addr.includes(":")) return null;

  // Embedded IPv4 tail, e.g. ::ffff:127.0.0.1.
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const v4hex =
      ((v4 >>> 16) & 0xffff).toString(16).padStart(4, "0") +
      ":" +
      (v4 & 0xffff).toString(16).padStart(4, "0");
    addr = addr.slice(0, lastColon + 1) + v4hex;
  }

  const segments = addr.split("::");
  if (segments.length > 2) return null;

  const head = segments[0] ? segments[0].split(":").filter((s) => s.length > 0) : [];
  const tail =
    segments.length === 2 && segments[1] ? segments[1].split(":").filter((s) => s.length > 0) : [];

  let hextets: string[];
  if (segments.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    hextets = [...head, ...Array(missing).fill("0"), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;

  let result = 0n;
  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    result = (result << 16n) | BigInt(parseInt(h, 16));
  }
  return result;
}

function parseIpv6Cidr(entry: string): { base: bigint; mask: bigint } | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const [ipPart, prefixPart] = trimmed.includes("/") ? trimmed.split("/") : [trimmed, "128"];
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const ip = ipv6ToBigInt(ipPart ?? "");
  if (ip === null) return null;
  const fullMask = (1n << 128n) - 1n;
  const mask = prefix === 0 ? 0n : (fullMask << BigInt(128 - prefix)) & fullMask;
  return { base: ip & mask, mask };
}

export function isIpv6Allowed(clientIp: string, cidrs: string[]): boolean {
  if (cidrs.length === 0) return false;
  const client = ipv6ToBigInt(clientIp);
  if (client === null) return false;
  for (const entry of cidrs) {
    const cidr = parseIpv6Cidr(entry);
    if (!cidr) continue;
    if ((client & cidr.mask) === cidr.base) return true;
  }
  return false;
}
