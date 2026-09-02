/**
 * SSRF guard for outbound requests to destinations merchants control (e.g.
 * their configured webhook URL). Protocol/HTTPS is enforced separately
 * (see https-url.ts); this module additionally verifies the resolved IP is
 * not a private/loopback/link-local/reserved address before we connect —
 * without it, a merchant could point their webhook URL at a domain they
 * control that resolves to internal infrastructure (e.g. cloud metadata at
 * 169.254.169.254) and receive our signed request there.
 *
 * The dispatcher returned here pins the connection to the exact IP(s) we
 * just validated, so a DNS answer that changes between the check and the
 * actual connect (DNS rebinding) can't bypass the check.
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, type Dispatcher } from "undici";

const IPV4_PRIVATE_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const target = ipv4ToInt(ip);
  return IPV4_PRIVATE_CIDRS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (target & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // unparseable — fail closed
}

/**
 * Resolve `hostname`, reject it if any resolved address is private/
 * reserved, and return an undici dispatcher pinned to the validated
 * addresses. Throws on a bare IP literal that is itself private.
 */
export async function createSsrfSafeDispatcher(hostname: string): Promise<Dispatcher> {
  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new Error(`Refusing to connect to private/reserved address: ${hostname}`);
    }
    return new Agent();
  }

  const records = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

  if (records.length === 0) {
    throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  }
  const unsafe = records.find((r) => isPrivateOrReservedIp(r.address));
  if (unsafe) {
    throw new Error(
      `Refusing to connect to ${hostname}: resolves to private/reserved address ${unsafe.address}`
    );
  }

  const pinned = records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));

  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const wantFamily = typeof options?.family === "number" ? options.family : 0;
        const candidates = wantFamily ? pinned.filter((p) => p.family === wantFamily) : pinned;
        const list = candidates.length > 0 ? candidates : pinned;
        if (options?.all) {
          callback(null, list);
        } else {
          callback(null, list[0]!.address, list[0]!.family);
        }
      },
    },
  });
}
