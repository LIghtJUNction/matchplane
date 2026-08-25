import type { Metadata } from "next";
import Script from "next/script";
import "../src/styles.css";
import "../src/retail-ui.css";

const DIRECTION_CONTRACT = `impeccable-direction:
world: warm paper marketplace, carbon ink, one calm axis, no brand imitation
first-viewport: one inline shopping prompt is the only primary action
visitor-path: describe need -> real assistant response -> truthful result-store trace -> products
signature-interaction: progressive search path rendered only from current visible recommendations
cross-surface-reach: root marketplace only; subplatform storefronts retain their own shell
motion-promise: short interruptible opacity/transform transitions; reduced motion is immediate
reference-boundary: composition only; no Anthropic identity, copy, assets, or exact layout
seed-key: home-routing-atlas-v1`;

export const metadata: Metadata = {
  title: "MatchPlane · 找到真正适合你的匹配",
  description:
    "MatchPlane AI 撮合平台：把真实需求交给合适的供给方，解释匹配理由，并在双方同意后交换联系。",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>
        <script>
          {`document.body.insertBefore(document.createComment(${JSON.stringify(DIRECTION_CONTRACT)}),document.body.firstChild);`}
        </script>
        {children}
      </body>
    </html>
  );
}
