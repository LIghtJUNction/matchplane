type SmsPayload = {
  phoneNumber: string;
  code: string;
};

/**
 * The authentication plugin owns OTP generation and persistence. This adapter
 * only hands the already-generated code to an operator-owned SMS gateway.
 * No provider credentials or vendor-specific request shape are stored in the
 * auth layer; the gateway URL is an explicit deployment setting.
 */
export async function sendConfiguredPhoneOtp({ phoneNumber, code }: SmsPayload): Promise<void> {
  const endpoint = process.env.MATCHPLANE_SMS_PROVIDER_URL?.trim();
  if (!endpoint) {
    throw new Error("手机号验证码服务尚未配置");
  }

  const url = safeProviderUrl(endpoint);
  if (!url) {
    throw new Error("手机号验证码服务必须使用 HTTPS 地址");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(process.env.MATCHPLANE_SMS_PROVIDER_TOKEN?.trim()
          ? { authorization: `Bearer ${process.env.MATCHPLANE_SMS_PROVIDER_TOKEN.trim()}` }
          : {}),
      },
      body: JSON.stringify({
        phoneNumber,
        code,
        purpose: "sign-in",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SMS provider returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function safeProviderUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}
