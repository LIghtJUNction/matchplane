#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IGNORED_DIRECTORY_NAMES = new Set([".next", "node_modules"]);
const SOURCE_DIRECTORY_NAMES = new Set(["app", "src"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_SOURCE_PATTERN = /\.(?:spec|test)\.[^/]+$/i;
const FIXTURE_NAME_PATTERN = /(?:^|[._-])fixtures?(?:[._-]|$)/i;

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
  assertDirectory(root, "standalone output is missing");

  const serverCandidates = [
    path.join(root, "server.js"),
    path.join(root, "web", "server.js"),
  ];
  const servers = serverCandidates.filter(isRegularFile);
  if (servers.length === 0) {
    throw new StandaloneValidationError(
      `standalone server output is missing (expected ${serverCandidates
        .map((candidate) => path.relative(root, candidate))
        .join(" or ")})`,
    );
  }

  const leaks = [];
  walkApplicationFiles(root, root, leaks);
  if (leaks.length > 0) {
    throw new StandaloneValidationError(
      `standalone output contains application source leaks:\n${leaks
        .sort((left, right) => left.localeCompare(right))
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    );
  }

  return {
    root,
    servers: servers.map((server) => path.relative(root, server)),
  };
}

function walkApplicationFiles(root, directory, leaks) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      if (
        SOURCE_DIRECTORY_NAMES.has(entry.name) ||
        FIXTURE_NAME_PATTERN.test(entry.name)
      ) {
        leaks.push(relative);
        continue;
      }
      walkApplicationFiles(root, absolute, leaks);
      continue;
    }
    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name).toLowerCase();
    if (
      SOURCE_EXTENSIONS.has(extension) ||
      TEST_SOURCE_PATTERN.test(entry.name) ||
      FIXTURE_NAME_PATTERN.test(entry.name)
    ) {
      leaks.push(relative);
    }
  }
}

function assertDirectory(candidate, message) {
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new StandaloneValidationError(`${message}: ${candidate}`);
  }
}

function isRegularFile(candidate) {
  return existsSync(candidate) && lstatSync(candidate).isFile();
}

function runCli() {
  try {
    const result = validateStandaloneOutput(process.argv[2]);
    console.log(
      `Standalone output validated at ${result.root} (${result.servers.join(", ")})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) runCli();
