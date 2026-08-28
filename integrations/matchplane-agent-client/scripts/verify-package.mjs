import { spawnSync } from "node:child_process";

const result = spawnSync(
  "npm",
  ["pack", "--dry-run", "--ignore-scripts", "--json"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const output = JSON.parse(result.stdout);
const manifest = Array.isArray(output) ? output[0] : Object.values(output)[0];
if (!manifest || !Array.isArray(manifest.files)) {
  throw new Error("npm pack did not return an inspectable file manifest");
}
const files = new Set(manifest.files.map(({ path }) => path));
const required = [
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "dist/index.js",
  "examples/buyer-agent.ts",
  "examples/seller-agent.ts",
  "scripts/verify-package.mjs",
  "src/index.ts",
];
const missing = required.filter((path) => !files.has(path));
if (missing.length > 0) {
  throw new Error(`agent-client package is missing public artifacts: ${missing.join(", ")}`);
}
console.log(`verified ${manifest.name}@${manifest.version} (${files.size} files)`);
