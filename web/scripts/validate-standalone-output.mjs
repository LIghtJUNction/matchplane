#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const APP_ENTRIES = new Map([
  [".next", "directory"],
  ["node_modules", "directory"],
  ["package.json", "file"],
  ["server.js", "file"],
]);
const WRAPPER_ENTRIES = new Map([
  ["node_modules", "directory"],
  ["web", "directory"],
]);
const RAW_SOURCE_EXTENSIONS = new Set([
  ".cts",
  ".jsx",
  ".mts",
  ".ts",
  ".tsx",
]);
const FORBIDDEN_SOURCE_DIRECTORIES = new Set([
  "__fixtures__",
  "__tests__",
  "fixture",
  "fixtures",
  "source",
  "sources",
  "src",
]);
const TEST_SOURCE_PATTERN = /\.(?:spec|test)\.[^/]+$/i;
const FIXTURE_FILE_PATTERN = /(?:^|[._-])fixtures?(?:[._-]|$)/i;

export class StandaloneValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StandaloneValidationError";
  }
}

export function validateStandaloneOutput(
  standaloneRoot = path.resolve(process.cwd(), ".next/standalone"),
) {
  const root = path.resolve(standaloneRoot);
  assertRealDirectory(root, "standalone output is missing");

  const rootNames = new Set(readDirectory(root).map((entry) => entry.name));
  const flatLayout = rootNames.has("server.js");
  const monorepoLayout = rootNames.has("web");
  if (flatLayout && monorepoLayout) {
    throw new StandaloneValidationError(
      "standalone output mixes package-local and monorepo layouts",
    );
  }
  if (!flatLayout && !monorepoLayout) {
    throw new StandaloneValidationError(
      "standalone server output is missing (expected server.js or web/server.js)",
    );
  }

  const leaks = [];
  let appRoot;
  let layout;
  if (flatLayout) {
    appRoot = root;
    layout = "package-local";
  } else {
    inspectAllowedEntries(root, WRAPPER_ENTRIES, ["web"], leaks);
    appRoot = path.join(root, "web");
    assertRealDirectory(appRoot, "monorepo app directory is missing");
    layout = "monorepo";
  }

  inspectAllowedEntries(
    appRoot,
    APP_ENTRIES,
    [".next", "package.json", "server.js"],
    leaks,
  );
  inspectCompiledTree(path.join(appRoot, ".next"), root, leaks);

  if (leaks.length > 0) {
    throw new StandaloneValidationError(
      `standalone output contains invalid application entries:\n${leaks
        .sort((left, right) => left.localeCompare(right))
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    );
  }

  return {
    layout,
    root,
    servers: [path.relative(root, path.join(appRoot, "server.js"))],
  };
}

function inspectAllowedEntries(directory, allowed, required, leaks) {
  const entries = readDirectory(directory);
  const names = new Set(entries.map((entry) => entry.name));
  for (const requiredName of required) {
    if (!names.has(requiredName)) {
      leaks.push(`${relativeTo(directory, requiredName)} (required entry missing)`);
    }
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = relativeToRoot(directory, absolute);
    if (entry.isSymbolicLink()) {
      leaks.push(`${relative} (symlink outside dependency tree)`);
      continue;
    }

    const expectedType = allowed.get(entry.name);
    if (!expectedType) {
      leaks.push(`${relative} (unexpected app-layout entry)`);
      continue;
    }
    if (
      (expectedType === "directory" && !entry.isDirectory()) ||
      (expectedType === "file" && !entry.isFile())
    ) {
      leaks.push(`${relative} (expected ${expectedType})`);
    }
  }
}

function inspectCompiledTree(directory, outputRoot, leaks) {
  if (!isRealDirectory(directory)) return;
  let entries;
  try {
    entries = readDirectory(directory);
  } catch (error) {
    leaks.push(`${path.relative(outputRoot, directory)} (${errorMessage(error)})`);
    return;
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(outputRoot, absolute);
    if (entry.isSymbolicLink()) {
      leaks.push(`${relative} (symlink outside dependency tree)`);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      if (FORBIDDEN_SOURCE_DIRECTORIES.has(entry.name.toLowerCase())) {
        leaks.push(`${relative} (source/fixture directory)`);
        continue;
      }
      inspectCompiledTree(absolute, outputRoot, leaks);
      continue;
    }
    if (!entry.isFile()) {
      leaks.push(`${relative} (unsupported filesystem entry)`);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (RAW_SOURCE_EXTENSIONS.has(extension)) {
      leaks.push(`${relative} (raw source file)`);
      continue;
    }
    if (
      TEST_SOURCE_PATTERN.test(entry.name) ||
      FIXTURE_FILE_PATTERN.test(entry.name)
    ) {
      leaks.push(`${relative} (test/fixture file)`);
      continue;
    }
    if (extension === ".map") inspectSourceMap(absolute, relative, leaks);
  }
}

function inspectSourceMap(filename, relative, leaks) {
  let sourceMap;
  try {
    sourceMap = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    leaks.push(`${relative} (source map cannot be parsed: ${errorMessage(error)})`);
    return;
  }

  const stack = [sourceMap];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    if (Object.hasOwn(value, "sourcesContent")) {
      const sourcesContent = value.sourcesContent;
      if (!Array.isArray(sourcesContent)) {
        if (sourcesContent !== null) {
          leaks.push(`${relative} (invalid sourcesContent)`);
          return;
        }
      } else if (
        sourcesContent.some(
          (source) =>
            (typeof source === "string" && source.length > 0) ||
            (source !== null && typeof source !== "string"),
        )
      ) {
        leaks.push(`${relative} (embedded sourcesContent)`);
        return;
      }
    }
    if (Array.isArray(value)) stack.push(...value);
    else stack.push(...Object.values(value));
  }
}

function readDirectory(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new StandaloneValidationError(
      `standalone directory cannot be read: ${directory} (${errorMessage(error)})`,
    );
  }
}

function assertRealDirectory(candidate, message) {
  if (!isRealDirectory(candidate)) {
    throw new StandaloneValidationError(`${message}: ${candidate}`);
  }
}

function isRealDirectory(candidate) {
  try {
    const stat = lstatSync(candidate);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function relativeTo(directory, name) {
  return path.join(path.basename(directory), name);
}

function relativeToRoot(directory, absolute) {
  const parent = path.basename(directory) === "web" ? path.dirname(directory) : directory;
  return path.relative(parent, absolute);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function runCli() {
  try {
    const result = validateStandaloneOutput(process.argv[2]);
    console.log(
      `Standalone output validated at ${result.root} (${result.layout}: ${result.servers.join(", ")})`,
    );
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) runCli();
