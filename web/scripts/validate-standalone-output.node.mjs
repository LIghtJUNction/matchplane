import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StandaloneValidationError,
  validateStandaloneOutput,
} from "./validate-standalone-output.mjs";

function withFixture(files, operation) {
  const root = mkdtempSync(path.join(tmpdir(), "matchplane-standalone-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts Docker and monorepo standalone layouts", async (t) => {
  await t.test("Docker /app layout", () => {
    withFixture(
      {
        "server.js": "// compiled server\n",
        "node_modules/example/src/index.ts": "export {};\n",
        "node_modules/example/example.test.ts": "export {};\n",
      },
      (root) => {
        assert.deepEqual(validateStandaloneOutput(root).servers, ["server.js"]);
      },
    );
  });

  await t.test("monorepo web layout", () => {
    withFixture(
      { "web/server.js": "// compiled server\n" },
      (root) => {
        assert.deepEqual(validateStandaloneOutput(root).servers, [
          path.join("web", "server.js"),
        ]);
      },
    );
  });
});

test("rejects missing server output", () => {
  withFixture({ ".keep": "" }, (root) => {
    assert.throws(
      () => validateStandaloneOutput(root),
      StandaloneValidationError,
    );
  });
});

test("rejects application source trees in either layout", async (t) => {
  for (const sourceFile of [
    "src/index.ts",
    "web/src/index.tsx",
    "web/app/route.js",
  ]) {
    await t.test(sourceFile, () => {
      const server = sourceFile.startsWith("web/")
        ? "web/server.js"
        : "server.js";
      withFixture(
        {
          [server]: "// compiled server\n",
          [sourceFile]: "export {};\n",
        },
        (root) => {
          assert.throws(
            () => validateStandaloneOutput(root),
            /application source leaks/,
          );
        },
      );
    });
  }
});

test("rejects test and fixture source outside node_modules", async (t) => {
  for (const leakedFile of [
    "web/lib/config.test.js",
    "web/fixtures/secret.json",
    "web/lib/provider.fixture.json",
  ]) {
    await t.test(leakedFile, () => {
      withFixture(
        {
          "web/server.js": "// compiled server\n",
          [leakedFile]: "fixture\n",
        },
        (root) => {
          assert.throws(
            () => validateStandaloneOutput(root),
            /application source leaks/,
          );
        },
      );
    });
  }
});
