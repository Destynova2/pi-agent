// Pi's file settings reader takes a write lock even for reads. Use its storage API
// for lock-free snapshots; never grant a language server writes to global settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager as NativeSettingsManager } from "@earendil-works/pi-coding-agent";
export * from "@earendil-works/pi-coding-agent";

export class SettingsManager extends NativeSettingsManager {
  static create(cwd, agentDir, options = {}) {
    const manager = NativeSettingsManager.fromStorage({
      withLock(scope, fn) {
        const path = scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi/settings.json");
        let current;
        try { current = readFileSync(path, "utf8"); }
        // Linux may mask a missing protected .pi directory with an empty file.
        catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
        if (fn(current) !== undefined) throw new Error("Confined LSP settings snapshot is read-only");
      },
    }, options);
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
    return manager;
  }
}
