import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Better Auth mounts a server route at /api/auth. A static export cannot execute
  // authentication handlers or keep HTTP-only sessions, so package the Next runtime.
  output: "standalone",
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    // Bun's isolated workspace linker stores packages in the monorepo root and
    // links them into `web/node_modules`. Turbopack must therefore use the
    // monorepo root as its filesystem boundary, otherwise Next 16 rejects the
    // linked `next/package.json` as being outside the workspace.
    root: path.resolve(__dirname, ".."),
  },
  // Keep API URLs canonical. Better Auth's router intentionally owns the
  // `/api/auth/*` path and treats a trailing slash as a distinct endpoint;
  // Next's global trailing-slash redirect would turn valid auth calls into
  // 404 responses. UI routes do not need a trailing slash to render.
  images: {
    unoptimized: true,
  },
  reactStrictMode: true,
};

export default nextConfig;
