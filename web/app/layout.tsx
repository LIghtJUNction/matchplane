import type { Metadata } from "next";
import Script from "next/script";
import "../src/styles.css";
import "../src/retail-ui.css";

export const metadata: Metadata = {
  title: "MatchPlane · 找到真正适合你的匹配",
  description:
    "MatchPlane 商城：说说预算和需求，从真实店铺挑选商品，双方同意后再交换联系方式。",
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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@400;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&display=swap"
          rel="stylesheet"
        />
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
