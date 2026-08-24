import { existsSync, writeFileSync } from "node:fs";
import {
  acquirePlatformRouterLock,
  PlatformRouterLockTimeoutError,
  readCurrentSnapshot,
} from "../transaction";

const mode = process.argv[2];

if (mode === "lock") {
  await runLockChild();
} else if (mode === "race-read") {
  await runRaceReader();
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

async function runRaceReader(): Promise<void> {
  const root = requiredArgument(3);
  const startBarrier = requiredArgument(4);
  const stopBarrier = requiredArgument(5);
  const resultBarrier = requiredArgument(6);
  await waitForFile(startBarrier, 8_000);
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
