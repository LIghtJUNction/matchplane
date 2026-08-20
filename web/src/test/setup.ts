import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);

// jsdom can expose an opaque origin when tests run under the unprivileged
// Arch `builder` account. In that mode Web Storage is unavailable (or its
// accessor throws a SecurityError), while the application intentionally uses
// storage for small client-side preferences. Keep the test environment
// deterministic without changing the production runtime.
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value));
  }
}

function ensureStorage(name: "localStorage" | "sessionStorage") {
  try {
    const storage = window[name];
    if (storage && typeof storage.clear === "function" && typeof storage.setItem === "function") {
      return;
    }
  } catch {
    // Replace jsdom's throwing accessor below.
  }

  Object.defineProperty(window, name, {
    configurable: true,
    value: new MemoryStorage(),
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock;
