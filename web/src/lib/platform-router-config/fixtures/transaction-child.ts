import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  createTransactionalManagedPlatformRouterLifecycle,
} from "../transactional-lifecycle";
import {
  acquirePlatformRouterLock,
  PlatformRouterLockTimeoutError,
  readCurrentSnapshot,
} from "../transaction";

const mode = process.argv[2];

if (mode === "lock") {
  await runLockChild();
} else if (mode === "stale-lock") {
  await runStaleLockChild();
} else if (mode === "race-read") {
  await runRaceReader();
} else if (mode === "audit-short-append") {
  await runAuditShortAppendChild();
} else if (mode === "lifecycle-stage") {
  await runLifecycleStageChild();
} else if (mode === "lifecycle-activate") {
  await runLifecycleActivateChild();
} else {
  throw new Error("unknown transaction child mode");
}

async function runLockChild(): Promise<void> {
  const root = requiredArgument(3);
  const startBarrier = requiredArgument(4);
  const resultBarrier = requiredArgument(5);
  const releaseBarrier = requiredArgument(6);
  const timeoutMs = Number(requiredArgument(7));
  const hold = requiredArgument(8) === "hold";
  await waitForFile(startBarrier, 8_000);
  try {
    const handle = await acquirePlatformRouterLock({ root, timeoutMs });
    writeFileSync(resultBarrier, JSON.stringify({ status: "acquired" }));
    if (hold) await waitForFile(releaseBarrier, 30_000);
    handle.release();
  } catch (cause) {
    writeFileSync(
      resultBarrier,
      JSON.stringify({
        status:
          cause instanceof PlatformRouterLockTimeoutError ? "timeout" : "error",
        errorName: cause instanceof Error ? cause.name : "unknown",
      }),
    );
    if (!(cause instanceof PlatformRouterLockTimeoutError)) process.exitCode = 1;
  }
}

async function runStaleLockChild(): Promise<void> {
  const root = requiredArgument(3);
  const inspectedBarrier = requiredArgument(4);
  const resumeBarrier = requiredArgument(5);
  const resultBarrier = requiredArgument(6);
  const timeoutMs = Number(requiredArgument(7));
  try {
    const handle = await acquirePlatformRouterLock({
      root,
      timeoutMs,
      beforeStaleTakeover: async () => {
        writeFileSync(inspectedBarrier, "inspected");
        await waitForFile(resumeBarrier, 8_000);
      },
    });
    writeFileSync(resultBarrier, JSON.stringify({ status: "acquired" }));
    handle.release();
  } catch (cause) {
    writeFileSync(
      resultBarrier,
      JSON.stringify({
        status:
          cause instanceof PlatformRouterLockTimeoutError ? "timeout" : "error",
        errorName: cause instanceof Error ? cause.name : "unknown",
      }),
    );
    if (!(cause instanceof PlatformRouterLockTimeoutError)) process.exitCode = 1;
  }
}

async function runAuditShortAppendChild(): Promise<void> {
  const auditPath = requiredArgument(3);
  const pausedBarrier = requiredArgument(4);
  const resumeBarrier = requiredArgument(5);
  const doneBarrier = requiredArgument(6);
  const bytes = Buffer.from(`${requiredArgument(7)}\n`);
  const descriptor = openSync(
    auditPath,
    fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY,
    0o640,
  );
  try {
    const firstLength = Math.max(1, Math.floor(bytes.length / 2));
    const written = writeSync(descriptor, bytes, 0, firstLength, null);
    if (written <= 0) throw new Error("short append made no progress");
    writeFileSync(pausedBarrier, String(written));
    await waitForFile(resumeBarrier, 8_000);
    let offset = written;
    while (offset < bytes.length) {
      const count = writeSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error("append completion made no progress");
      offset += count;
    }
    fsyncSync(descriptor);
    writeFileSync(doneBarrier, "done");
  } finally {
    closeSync(descriptor);
  }
}

async function runLifecycleStageChild(): Promise<void> {
  const root = requiredArgument(3);
  const startBarrier = requiredArgument(4);
  const resultBarrier = requiredArgument(5);
  const model = requiredArgument(6);
  const apiKey = requiredArgument(7);
  await waitForFile(startBarrier, 8_000);
  const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
    transactionOptions: { root, timeoutMs: 8_000 },
  });
  try {
    const result = await lifecycle.stage(
      {
        endpoint: "https://api.lmm.best/v1",
        model,
        protocol: "openai-compatible",
        enabled: true,
        apiKey,
      },
      { actor: `child-${model}`, requestId: `stage-${model}` },
    );
    writeFileSync(resultBarrier, JSON.stringify({ status: "committed", result }));
  } catch (cause) {
    writeFileSync(
      resultBarrier,
      JSON.stringify({
        status: "error",
        errorName: cause instanceof Error ? cause.name : "unknown",
      }),
    );
  }
}

async function runLifecycleActivateChild(): Promise<void> {
  const root = requiredArgument(3);
  const startBarrier = requiredArgument(4);
  const resultBarrier = requiredArgument(5);
  await waitForFile(startBarrier, 8_000);
  const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
    transactionOptions: { root, timeoutMs: 8_000 },
  });
  try {
    const result = await lifecycle.activate({
      actor: "child-activate",
      requestId: "activate-race",
    });
    writeFileSync(resultBarrier, JSON.stringify({ status: "committed", result }));
  } catch (cause) {
    writeFileSync(
      resultBarrier,
      JSON.stringify({
        status: "error",
        errorName:
          cause instanceof Error ? cause.constructor.name : "unknown",
      }),
    );
  }
}

async function runRaceReader(): Promise<void> {
  const root = requiredArgument(3);
  const startBarrier = requiredArgument(4);
  const stopBarrier = requiredArgument(5);
  const resultBarrier = requiredArgument(6);
  await waitForFile(startBarrier, 8_000);
  writeFileSync(`${startBarrier}.ready`, "ready");
  const models = new Set<string>();
  const errors: string[] = [];
  const deadline = Date.now() + 12_000;
  while (!existsSync(stopBarrier) && Date.now() < deadline) {
    try {
      const snapshot = readCurrentSnapshot({ root });
      if (snapshot.active) models.add(snapshot.active.model);
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.name : "unknown");
    }
    await delay(1);
  }
  writeFileSync(
    resultBarrier,
    JSON.stringify({ models: [...models].sort(), errors }),
  );
}

async function waitForFile(target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error("barrier timeout");
    await delay(10);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (!value) throw new Error(`missing argument ${index}`);
  return value;
}
