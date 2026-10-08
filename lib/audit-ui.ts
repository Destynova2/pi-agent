import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { currentAuditContext, withAuditContext, type AuditContext } from "./audit-events.ts";
import { sensitiveDialog } from "./audit-redaction.ts";

type RecordEvent = (context: AuditContext, kind: string, payload: unknown) => void;

/** Decorate public dialogs only; never intercept keystrokes or render opaque custom components. */
export function auditUI(ui: ExtensionUIContext, context: () => AuditContext, record: RecordEvent, failed: (error: unknown) => void): () => void {
  const originals = { select: ui.select, confirm: ui.confirm, input: ui.input, editor: ui.editor, custom: ui.custom, notify: ui.notify };
  const write: RecordEvent = (origin, kind, payload) => {
    try { record(origin, kind, payload); }
    catch (error) { failed(error); throw error; }
  };
  const prompt = async <T>(kind: string, title: string, content: unknown, action: () => Promise<T>, options?: ExtensionUIDialogOptions): Promise<T> => {
    // Snapshot before awaiting: navigation and concurrent tools must never relabel an answer.
    const origin = { ...(currentAuditContext() ?? context()), dialogId: randomUUID() };
    const started = Date.now();
    const sensitive = sensitiveDialog(title) && (kind === "input" || kind === "editor");
    write(origin, "dialog.open", { kind, title, content: sensitive ? "[REDACTED]" : content, timeoutMs: options?.timeout,
      coverage: kind === "custom" ? "opaque-custom-ui" : "structured-ui" });
    let result: T;
    try { result = await withAuditContext(origin, action); }
    catch (error) {
      write(origin, "dialog.error", { kind, error, durationMs: Date.now() - started, aborted: options?.signal?.aborted ?? false });
      throw error;
    }
    write(origin, "dialog.answer", { kind, response: sensitive ? "[REDACTED]" : kind === "custom" ? "[OMITTED: opaque custom result]" : result,
      // confirm(false) conflates refusal, Escape and timeout in the Pi API. Do not invent a cause.
      outcome: options?.signal?.aborted ? "aborted" : result === undefined ? "dismissed" : kind === "confirm" && result === false ? "negative-or-dismissed" : "answered",
      durationMs: Date.now() - started });
    return result;
  };
  const wrappers = {
    select: ((title, choices, options) => prompt("select", title, { choices }, () => originals.select.call(ui, title, choices, options), options)) as ExtensionUIContext["select"],
    confirm: ((title, message, options) => prompt("confirm", title, { message }, () => originals.confirm.call(ui, title, message, options), options)) as ExtensionUIContext["confirm"],
    input: ((title, placeholder, options) => prompt("input", title, { placeholder }, () => originals.input.call(ui, title, placeholder, options), options)) as ExtensionUIContext["input"],
    editor: ((title, prefill) => prompt("editor", title, { prefill }, () => originals.editor.call(ui, title, prefill))) as ExtensionUIContext["editor"],
    custom: (async (factory, options) => {
      const custom = originals.custom.bind(ui);
      return prompt("custom", "Custom component", { overlay: options?.overlay, content: "Not exposed by the public UI API" }, () => custom(factory, options));
    }) as ExtensionUIContext["custom"],
    notify: ((message, type) => {
      originals.notify.call(ui, message, type);
      try { record(currentAuditContext() ?? context(), "ui.notification", { message, type: type ?? "info" }); }
      catch (error) { failed(error); }
    }) as ExtensionUIContext["notify"],
  };
  Object.assign(ui, wrappers);
  return () => {
    // Do not overwrite a later decorator installed by another extension.
    for (const name of Object.keys(wrappers) as (keyof typeof wrappers)[]) {
      if (ui[name] === wrappers[name]) Object.defineProperty(ui, name, { value: originals[name], writable: true, enumerable: true, configurable: true });
    }
  };
}
