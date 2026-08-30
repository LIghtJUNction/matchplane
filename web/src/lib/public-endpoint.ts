import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

export type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

// IANA currently allocates global IPv6 unicast from this envelope; deny unallocated space by default.
const CURRENT_GLOBAL_IPV6_UNICAST = ipaddr.parseCIDR("2000::/3");

/** Return true for IP literals that must never be reached through a server-side configurable URL. */
export function isPrivateOrReservedIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(normalized);
  if (family === 0) return false;

  try {
    const address = ipaddr.process(normalized);
    if (address.range() !== "unicast") return true;
    if (family === 6 && address.kind() === "ipv4") return true;
    return family === 6 && !address.match(CURRENT_GLOBAL_IPV6_UNICAST);
  } catch {
    return true;
  }
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

export async function resolvePublicAddresses(
  hostname: string,
): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}
