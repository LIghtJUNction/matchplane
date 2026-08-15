import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Better Auth mounts a server route at /api/auth. A static export cannot execute
  // authentication handlers or keep HTTP-only sessions, so package the Next runtime.
  output: "standalone",
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: path.resolve(__dirname),
  },
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
};

export default nextConfig;
