import path from "node:path";
import type { NextConfig } from "next";

// The Docker builder copies `web/` into `/app`, while the repository keeps it
// at `<monorepo>/web`. Keep one config valid in both layouts.
const workspaceRoot =
  path.basename(__dirname) === "web"
    ? path.resolve(__dirname, "..")
    : __dirname;

const nextConfig: NextConfig = {
  // Better Auth mounts a server route at /api/auth. A static export cannot execute
  // authentication handlers or keep HTTP-only sessions, so package the Next runtime.
  output: "standalone",
  poweredByHeader: false,
  // Keep file tracing aligned with the Turbopack boundary. Next 16 may place
  // the standalone app at `.next/standalone/web` for this monorepo layout; the
  // packaging and container stages normalize that directory to their runtime
  // root (`/app` or `/usr/share/matchplane/web`).
  outputFileTracingRoot: workspaceRoot,
  outputFileTracingExcludes: {
    "**": ["app/**/*", "src/**/*"],
  },
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  experimental: {
    // Avoid one page-data worker per host core overwhelming memory-bounded builders.
    cpus: 2,
  },
  turbopack: {
    // Bun's isolated workspace linker stores packages in the monorepo root and
    // links them into `web/node_modules`. Turbopack must therefore use the
    // monorepo root as its filesystem boundary, otherwise Next 16 rejects the
    // linked `next/package.json` as being outside the workspace.
    root: workspaceRoot,
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
