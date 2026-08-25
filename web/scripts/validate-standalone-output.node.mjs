import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StandaloneValidationError,
  validateStandaloneOutput,
} from "./validate-standalone-output.mjs";

function currentMonorepoFiles() {
  return {
    "node_modules/.bun/example/node_modules/example/src/dependency.ts":
      "export {};\n",
    "web/.next/BUILD_ID": "build-id\n",
    "web/.next/app-path-routes-manifest.json": "{}\n",
    "web/.next/package.json": '{"type":"commonjs"}\n',
    "web/.next/server/app/api/platform/email-config/test/route.js":
      "exports.route = {};\n",
    "web/.next/server/app/api/platform/email-config/test/route.js.map":
      '{"version":3,"sources":["route.js"],"mappings":""}\n',
    "web/node_modules/example/src/dependency.ts": "export {};\n",
    "web/package.json": '{"name":"@matchplane/web"}\n',
    "web/server.js": "// compiled server\n",
  };
}

function dockerLayoutFiles() {
  return {
    ".next/BUILD_ID": "build-id\n",
    ".next/package.json": '{"type":"commonjs"}\n',
    ".next/server/app/page.js": "exports.page = {};\n",
    "node_modules/example/src/dependency.ts": "export {};\n",
    "package.json": '{"name":"@matchplane/web"}\n',
    "server.js": "// compiled server\n",
  };
}

function withFixture(files, links, operation) {
  const root = mkdtempSync(path.join(tmpdir(), "matchplane-standalone-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    for (const link of links) {
      const target = path.join(root, link.path);
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(link.target, target, link.type);
    }
    operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertRejected(files, links = [], pattern = /invalid application entries/) {
  withFixture(files, links, (root) => {
    assert.throws(() => validateStandaloneOutput(root), pattern);
  });
}

test("accepts the current monorepo standalone layout", () => {
  withFixture(
    currentMonorepoFiles(),
    [
      {
        path: "node_modules/example",
        target: ".bun/example/node_modules/example",
        type: "dir",
      },
      {
        path: "web/.next/node_modules/example",
        target: "../../../node_modules/.bun/example/node_modules/example",
        type: "dir",
      },
    ],
    (root) => {
      assert.deepEqual(validateStandaloneOutput(root), {
        layout: "monorepo",
        root,
        servers: [path.join("web", "server.js")],
      });
    },
  );
});

test("accepts the normalized Docker /app layout", () => {
  withFixture(dockerLayoutFiles(), [], (root) => {
    assert.deepEqual(validateStandaloneOutput(root), {
      layout: "package-local",
      root,
      servers: ["server.js"],
    });
  });
});

test("Dockerfile validates the normalized release tree in the builder", () => {
  const dockerfile = readFileSync(
    new URL("../../deploy/compose/web.Dockerfile", import.meta.url),
    "utf8",
  );
  const normalization = dockerfile.indexOf("mkdir -p /app/standalone");
  const pruning = dockerfile.indexOf(
    "rm -rf /app/standalone/app /app/standalone/src",
  );
  const validation = dockerfile.indexOf(
    "node /app/scripts/validate-standalone-output.mjs /app/standalone",
  );
  const runner = dockerfile.indexOf(" AS runner");
  assert.ok(normalization >= 0, "Docker normalization step is missing");
  assert.equal(pruning, -1, "traced source must be excluded during the Next build");
  assert.ok(validation > normalization, "release validation must follow normalization");
  assert.ok(runner > validation, "release validation must run in the builder");
});

test("rejects missing and mixed server layouts", () => {
  assertRejected(
    { "package.json": "{}\n" },
    [],
    StandaloneValidationError,
  );
  assertRejected(
    { ...dockerLayoutFiles(), "web/server.js": "// second server\n" },
    [],
    /mixes package-local and monorepo layouts/,
  );
});

test("rejects unexpected app-layout source and fixture trees", async (t) => {
  for (const leakedFile of [
    "web/lib/private.jsx",
    "web/__tests__/secrets.json",
    "web/copied/.next/src/private.ts",
  ]) {
    await t.test(leakedFile, () => {
      assertRejected({ ...currentMonorepoFiles(), [leakedFile]: "private\n" });
    });
  }
});

test("rejects source symlinks outside dependency trees", async (t) => {
  for (const link of [
    {
      path: "web/private.ts",
      target: "../node_modules/.bun/example/node_modules/example/src/dependency.ts",
      type: "file",
    },
    {
      path: "web/src",
      target: "../node_modules/.bun/example/node_modules/example/src",
      type: "dir",
    },
  ]) {
    await t.test(link.path, () => {
      assertRejected(currentMonorepoFiles(), [link], /symlink outside dependency tree/);
    });
  }
});

test("rejects raw source and fixtures inside compiled .next", async (t) => {
  for (const leakedFile of [
    "web/.next/server/src/private.ts",
    "web/.next/server/copied/private.mts",
    "web/.next/server/__fixtures__/secrets.json",
    "web/.next/server/page.test.js",
  ]) {
    await t.test(leakedFile, () => {
      assertRejected({ ...currentMonorepoFiles(), [leakedFile]: "private\n" });
    });
  }
});

test("rejects source maps with embedded source and malformed maps", async (t) => {
  await t.test("sourcesContent", () => {
    assertRejected({
      ...currentMonorepoFiles(),
      "web/.next/server/page.js.map": JSON.stringify({
        version: 3,
        sources: ["private.ts"],
        sourcesContent: ["export const secret = 'fixture';"],
        mappings: "",
      }),
    }, [], /embedded sourcesContent/);
  });

  await t.test("malformed map", () => {
    assertRejected({
      ...currentMonorepoFiles(),
      "web/.next/server/page.js.map": "not-json\n",
    }, [], /source map cannot be parsed/);
  });
});
