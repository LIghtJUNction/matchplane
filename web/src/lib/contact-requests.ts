"use client";

const STORAGE_PREFIX = "matchplane.contactRequested.";

/**
 * Remembers that this browser sent a consent-gated contact request in a store,
 * so the buyer status panel only establishes marketplace sessions for involved
 * visitors instead of every signed-in browser.
 */
export function markStoreContactRequested(platformPath: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${platformPath}`, "1");
  } catch {
    // Blocked storage only hides the status panel until the next request.
  }
}

export function hasStoreContactRequested(platformPath: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(`${STORAGE_PREFIX}${platformPath}`) === "1"
    );
  } catch {
    return false;
  }
}
