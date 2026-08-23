import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

const RESERVED_IPV4_ADDRESSES = new BlockList();
const RESERVED_IPV6_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) {
  RESERVED_IPV4_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  RESERVED_IPV6_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

/** Return true for IP literals that must never be reached through a server-side configurable URL. */
export function isPrivateOrReservedIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return RESERVED_IPV4_ADDRESSES.check(normalized, "ipv4");
  if (family === 6) return RESERVED_IPV6_ADDRESSES.check(normalized, "ipv6");
  return false;
}

/** Resolve a URL immediately before a request and fail closed unless every address is public. */
export async function hasOnlyPublicAddresses(
  value: string,
  resolveAddresses: ResolveAddresses = resolvePublicAddresses,
): Promise<boolean> {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
    if (!hostname) return false;
    if (isIP(hostname)) return !isPrivateOrReservedIpLiteral(hostname);
    const addresses = await resolveAddresses(hostname);
    return (
      addresses.length > 0 &&
      addresses.every(
        (address) =>
          isIP(address) !== 0 && !isPrivateOrReservedIpLiteral(address),
      )
    );
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}
