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
