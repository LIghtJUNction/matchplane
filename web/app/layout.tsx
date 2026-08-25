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
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>{children}</body>
    </html>
  );
}
