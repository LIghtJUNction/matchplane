import type { Metadata } from "next";
import "../src/styles.css";

export const metadata: Metadata = {
  title: "MatchPlane · 找到真正适合你的车",
  description:
    "MatchPlane 二手车智能撮合平台：更高效的卖车曝光、更适合需求的车辆推荐，以及透明的平台服务保障。",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
