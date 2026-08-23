import { describe, expect, it } from "vitest";

import { managedImageKeyMatches } from "./lib/managed-image";

const OWNER_ID = "123e4567-e89b-42d3-a456-426614174000";
const IMAGE_ID = "018f0be4-8d4a-7df2-a4d1-123456789abc";

describe("managed image keys", () => {
  it("accepts an exact scope with UUID path segments", () => {
    expect(
      managedImageKeyMatches(`profile/${OWNER_ID}/${IMAGE_ID}.webp`, "profile"),
    ).toBe(true);
    expect(
      managedImageKeyMatches(`brand/${OWNER_ID}/${IMAGE_ID}.webp`, "brand"),
    ).toBe(true);
  });

  it("rejects traversal, the wrong scope, and malformed file names", () => {
    expect(
      managedImageKeyMatches(
        `profile/${OWNER_ID}/../${IMAGE_ID}.webp`,
        "profile",
      ),
    ).toBe(false);
    expect(
      managedImageKeyMatches(`brand/${OWNER_ID}/${IMAGE_ID}.webp`, "profile"),
    ).toBe(false);
    expect(
      managedImageKeyMatches(`profile/${OWNER_ID}/${IMAGE_ID}.png`, "profile"),
    ).toBe(false);
    expect(
      managedImageKeyMatches(`profile/not-a-uuid/${IMAGE_ID}.webp`, "profile"),
    ).toBe(false);
  });
});
