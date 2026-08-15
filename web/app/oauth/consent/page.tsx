import { Suspense } from "react";

import { OAuthConsentScreen } from "../../../src/components/OAuthConsentScreen";

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<main className="login-page"><p>正在准备授权确认…</p></main>}>
      <OAuthConsentScreen />
    </Suspense>
  );
}
