import { describe, expect, it } from "vitest";

import {
  hasOnlyPublicAddresses,
  isPrivateOrReservedIpLiteral,
} from "./lib/public-endpoint";

describe("public outbound endpoint validation", () => {
  it("rejects private, loopback, metadata, documentation, and mapped IP literals", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateOrReservedIpLiteral(address), address).toBe(true);
    }
    expect(isPrivateOrReservedIpLiteral("93.184.216.34")).toBe(false);
    expect(
      isPrivateOrReservedIpLiteral("2606:2800:220:1:248:1893:25c8:1946"),
    ).toBe(false);
  });

  it("fails closed when any DNS answer is private or resolution fails", async () => {
    await expect(
      hasOnlyPublicAddresses("https://provider.example/v1/models", async () => [
        "93.184.216.34",
        "10.0.0.1",
      ]),
    ).resolves.toBe(false);
    await expect(
      hasOnlyPublicAddresses("https://provider.example/v1/models", async () => {
        throw new Error("DNS unavailable");
      }),
    ).resolves.toBe(false);
  });

  it("accepts a host only when every resolved address is public", async () => {
    await expect(
      hasOnlyPublicAddresses("https://provider.example/v1/models", async () => [
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]),
    ).resolves.toBe(true);
  });
});
