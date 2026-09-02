/**
 * Cloudflare's published edge IPv4 ranges (https://www.cloudflare.com/ips-v4).
 * Used to confirm a request's direct TCP peer really is a Cloudflare edge node
 * before trusting that edge's `CF-Connecting-IP` header (see client-ip.ts).
 */
export const CLOUDFLARE_IPV4_CIDRS: string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

/**
 * Cloudflare's published edge IPv6 ranges (https://www.cloudflare.com/ips-v6).
 * Without these, a peer that reaches the origin over IPv6 always fails the
 * IPv4-only check and falls through to the spoofable trustProxy fallback.
 */
export const CLOUDFLARE_IPV6_CIDRS: string[] = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];
