import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = existsSync(join(process.cwd(), "web", "next.config.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..");
const nextConfigSource = readFileSync(
  join(repositoryRoot, "web", "next.config.ts"),
  "utf8",
);
const nginxSource = readFileSync(
  join(repositoryRoot, "deploy", "nginx", "matchplane.conf"),
  "utf8",
);

describe("production framework and build-resource contract", () => {
  it("disables Next and Nginx version headers at their shared boundaries", () => {
    expect(nextConfigSource).toMatch(/const nextConfig:\s*NextConfig\s*=/);
    expect(nextConfigSource).toMatch(/\bpoweredByHeader:\s*false\b/);

    const serverTokenDirectives = [
      ...nginxSource.matchAll(/\bserver_tokens\s+off\s*;/g),
    ];
    expect(serverTokenDirectives).toHaveLength(1);
    expect(braceDepthAt(nginxSource, serverTokenDirectives[0].index)).toBe(0);

    const httpsServerStart = nginxSource.indexOf(
      "server {\n    listen 443 ssl",
    );
    expect(httpsServerStart).toBeGreaterThanOrEqual(0);
    const httpsServer = blockAt(nginxSource, httpsServerStart);
    expect(httpsServer).toMatch(/\bproxy_hide_header\s+X-Powered-By\s*;/);
  });

  it("caps Next page-data worker fan-out at two", () => {
    const experimentalStart = nextConfigSource.indexOf("experimental: {");
    expect(experimentalStart).toBeGreaterThanOrEqual(0);
    expect(nextConfigSource.match(/\bcpus\s*:/g)).toHaveLength(1);
    expect(blockAt(nextConfigSource, experimentalStart)).toMatch(
      /\bcpus:\s*2\b/,
    );
  });
});

function braceDepthAt(source: string, index: number): number {
  let depth = 0;
  for (const character of source.slice(0, index)) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

function blockAt(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}
