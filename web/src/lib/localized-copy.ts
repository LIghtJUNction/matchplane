import type { InterfaceLocale } from "./preferences";
import { subplatformCopy, type SubplatformConfig } from "../subplatform";

/**
 * Resolve copy owned by a mounted package while keeping the root fallback
 * domain-neutral. English package overrides use the explicit `<key>En` form;
 * this keeps existing manifests backwards-compatible and avoids inventing
 * translations for seller-provided schema labels.
 */
export function localizedSubplatformCopy(
  subplatform: SubplatformConfig,
  locale: InterfaceLocale,
  key: string,
  fallbackZh: string,
  fallbackEn = fallbackZh,
): string {
  if (locale === "en") {
    return subplatformCopy(subplatform, `${key}En`, fallbackEn);
  }
  return subplatformCopy(subplatform, key, fallbackZh);
}
