import type { Metadata } from "next";
import Script from "next/script";
import "../src/styles.css";
import "../src/archive-ui.css";

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
      <body>{children}</body>
    </html>
  );
}
