import { describe, expect, it } from "vitest";
import type { AssetListing } from "../types";
import {
  canSortCatalogByPrice,
  filterCatalogListings,
  listingCategory,
  sortCatalogListings,
} from "./catalog-browse";

function item(id: string, overrides: Partial<AssetListing> = {}): AssetListing {
  return {
    id,
    title: id,
    subtitle: "",
    price: "价格待询",
    seller: "店主",
    storeName: "青禾店铺",
    accent: "cactus",
    facts: [],
    description: "",
    ...overrides,
  };
}

function priced(id: string, amount: string, scale = 2, currency = "CNY") {
  return item(id, {
    priceAmountMinor: amount,
    priceCurrencyScale: scale,
    priceCurrency: currency,
  });
}

const ids = (listings: readonly AssetListing[]) =>
  listings.map((listing) => listing.id);

describe("loaded catalog browsing", () => {
  it("recognizes store-defined category labels without assuming a product vertical", () => {
    expect(
      listingCategory(
        item("a", { facts: [{ label: "品类", value: " 家居 " }] }),
      ),
    ).toBe("家居");
    expect(
      listingCategory(
        item("b", {
          facts: [{ key: "PRODUCT_CATEGORY", label: "Type", value: "Audio" }],
        }),
      ),
    ).toBe("Audio");
    expect(listingCategory(item("c"))).toBe("");
  });

  it("matches normalized words across product, store, location and facts", () => {
    const camera = item("camera", {
      title: "Sony Ａ７Ｃ",
      location: "杭州",
      facts: [{ key: "category", label: "分类", value: "数码" }],
    });
    const chair = item("chair", {
      title: "椅子",
      facts: [{ label: "品类", value: "家居" }],
    });
    expect(
      ids(
        filterCatalogListings([camera, chair], " SONY a7c 杭州 青禾 ", "数码"),
      ),
    ).toEqual(["camera"]);
    expect(filterCatalogListings([camera, chair], "Sony", "家居")).toEqual([]);
    expect(filterCatalogListings([camera, chair], " ", "")).toEqual([
      camera,
      chair,
    ]);
  });

  it("sorts canonical prices at different scales and leaves unknown prices last", () => {
    const source = [
      priced("five", "5", 0),
      item("unknown", { price: "¥0.01" }),
      priced("three", "300"),
    ];
    expect(canSortCatalogByPrice(source)).toBe(true);
    expect(ids(sortCatalogListings(source, "price-asc"))).toEqual([
      "three",
      "five",
      "unknown",
    ]);
    expect(ids(sortCatalogListings(source, "price-desc"))).toEqual([
      "five",
      "three",
      "unknown",
    ]);
    expect(ids(source)).toEqual(["five", "unknown", "three"]);
  });

  it("keeps integer precision beyond Number.MAX_SAFE_INTEGER", () => {
    const source = [
      priced("larger", "9007199254740993"),
      priced("smaller", "9007199254740992"),
    ];
    expect(ids(sortCatalogListings(source, "price-asc"))).toEqual([
      "smaller",
      "larger",
    ]);
  });

  it("does not pretend different currencies are comparable", () => {
    const source = [priced("yuan", "200"), priced("dollar", "100", 2, "USD")];
    expect(canSortCatalogByPrice(source)).toBe(false);
    expect(sortCatalogListings(source, "price-asc")).toEqual(source);
  });

  it("does not parse display prices or treat incomplete/invalid money as zero", () => {
    const source = [
      item("display", { price: "¥1,299" }),
      priced("negative", "-1"),
      priced("fractional-minor", "1.5"),
      priced("scale", "100", 19),
      priced("currency", "100", 2, "??"),
      item("incomplete", { priceAmountMinor: "0", priceCurrency: "CNY" }),
    ];
    expect(canSortCatalogByPrice(source)).toBe(false);
    expect(sortCatalogListings(source, "price-asc")).toEqual(source);
  });

  it("preserves the supplied order for default sorting and equal prices", () => {
    const source = [priced("b", "100"), priced("a", "1", 0)];
    expect(sortCatalogListings(source, "default")).toEqual(source);
    expect(sortCatalogListings(source, "price-desc")).toEqual(source);
  });
});
