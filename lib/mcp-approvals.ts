import { createHash } from "node:crypto";

export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]));
})).digest("hex");
