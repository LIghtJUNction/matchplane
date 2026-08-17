import { afterEach, describe, expect, it, vi } from "vitest";

import { isPhoneOtpConfigured } from "./sms";

describe("isPhoneOtpConfigured", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects an absent or unsafe endpoint", () => {
    expect(isPhoneOtpConfigured({})).toBe(false);
    expect(isPhoneOtpConfigured({ MATCHPLANE_SMS_PROVIDER_URL: "http://sms.example.test" })).toBe(false);
  });

  it("accepts an HTTPS gateway endpoint", () => {
    expect(isPhoneOtpConfigured({ MATCHPLANE_SMS_PROVIDER_URL: "https://sms.example.test/send" })).toBe(true);
  });
});
