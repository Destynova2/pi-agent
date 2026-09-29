// Deliberately recognizes a small command language, not arbitrary shell intent.
// Anything outside it asks. Trusted executables/extensions/environment remain a prerequisite.
import { lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { canonical, inside, resolveLikePi } from "./core.ts";

const SENSITIVE = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.config|\.pi|\.git|\.npmrc|\.netrc|auth\.json|credentials(?:\.[^/\\]*)?|secrets?(?:\.[^/\\]*)?|id_(?:rsa|ed25519)|[^/\\]*\.(?:pem|key|p12|pfx))(?:[/\\]|$)/i;

export function taskPathReason(raw: unknown, cwd: string, fileOnly = false): string | undefined {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) return "missing or invalid path";
  try {
    const target = resolveLikePi(raw, cwd);
    const real = canonical(target);
    if (!inside(canonical(cwd), real)) return "outside the task working directory";
    if (SENSITIVE.test(target) || SENSITIVE.test(real)) return "potentially sensitive path";
    try {
      const stat = lstatSync(real);
      if (stat.isFile() && stat.nlink > 1) return "hard-linked file";
      if (fileOnly && !stat.isFile()) return "content searches require an explicit regular file";
      if (!stat.isFile() && !stat.isDirectory()) return "special file";
    } catch (error) {
      if (fileOnly || (error as NodeJS.ErrnoException).code !== "ENOENT") return "unresolved file";
    }
    return undefined;
  } catch { return "unresolved path"; }
}

// No expansion, escapes, operators, redirection, globbing, or concatenated quote fragments.
// Rejecting these even inside quotes is intentional: fewer prompts is not worth a shell-parser bug.
function words(command: unknown): string[] | undefined {
  if (typeof command !== "string" || command.length > 4000 || /[\x00-\x1f\x7f$`\\;&|<>*?{}\[\]()!#~]/.test(command)) return undefined;
  const result: string[] = [];
  const token = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))(?:\s+|$)/gy;
  let offset = 0;
  while (offset < command.length) {
    if (!command.slice(offset).trim()) break;
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match) return undefined;
    result.push(match[1] ?? match[2] ?? match[3]);
    offset = token.lastIndex;
  }
  return result.length ? result : undefined;
}

export type TaskDecision = { action: "allow" | "ask" | "test"; reason: string };

export function taskDecision(name: string, input: Record<string, unknown>, cwd: string, agentDir?: string): TaskDecision {
  const ask = (reason: string): TaskDecision => ({ action: "ask", reason });
  const allowed: TaskDecision = { action: "allow", reason: "scoped routine operation" };
  // Installed skill collections may be user-created directory symlinks. Trust that collection,
  // not symlinks escaping it, and only allow reading Markdown instructions/references.
  if (name === "read" && agentDir && typeof input.path === "string") {
    try {
      const skills = join(agentDir, "skills");
      const target = resolveLikePi(input.path, cwd);
      if (inside(skills, target) && /\.md$/i.test(target)) {
        const collection = canonical(join(skills, relative(skills, target).split(sep)[0]));
        const real = canonical(target);
        const stat = lstatSync(real);
        if (lstatSync(collection).isDirectory() && inside(collection, real) && /\.md$/i.test(real) &&
            !SENSITIVE.test(relative(collection, real)) && stat.isFile() && stat.nlink === 1) {
          return { action: "allow", reason: "installed skill documentation" };
        }
      }
    } catch { /* Unresolved skill paths use the normal task rules. */ }
  }
  if (["read", "write", "edit", "ls", "find", "grep"].includes(name)) {
    const raw = input.path ?? (["ls", "find", "grep"].includes(name) ? "." : undefined);
    const reason = taskPathReason(raw, cwd, name === "grep");
    return reason ? ask(reason) : allowed;
  }
  if (name !== "bash") return ask("no task rule for this tool");
  const args = words(input.command);
  if (!args) return ask("compound or unsupported shell syntax");
  const [program, ...rest] = args;
  if (program === "pwd" && rest.length === 0) return allowed;
  if (program === "ls") {
    for (const arg of rest) {
      if (/^-[alhd1]+$/.test(arg)) continue;
      if (arg.startsWith("-") || taskPathReason(arg, cwd)) return ask("unrecognized listing option or path outside scope");
    }
    return taskPathReason(".", cwd) ? ask("potentially sensitive working directory") : allowed;
  }
  if (program === "find" && rest.length > 0 && !rest[0].startsWith("-") && !taskPathReason(rest[0], cwd)) {
    for (let i = 1; i < rest.length; i += 2) {
      const option = rest[i];
      const value = rest[i + 1];
      if (option === "-maxdepth" && /^\d+$/.test(value ?? "")) continue;
      if (option === "-type" && ["f", "d"].includes(value)) continue;
      if (option === "-name" && value && !value.startsWith("-")) continue;
      return ask("unrecognized find predicate");
    }
    return allowed;
  }
  if (program === "rg") {
    if (rest[0] === "--files" && rest.slice(1).every(p => !p.startsWith("-") && !taskPathReason(p, cwd))) return allowed;
    let index = 0;
    while (/^-[nilFw]+$/.test(rest[index] ?? "")) index++;
    const pattern = rest[index++];
    const files = rest.slice(index);
    if (pattern && !pattern.startsWith("-") && files.length && files.every(p => !p.startsWith("-") && !taskPathReason(p, cwd, true))) return allowed;
    return ask("content search needs explicit regular files and recognized flags");
  }
  if (["wc", "head", "tail"].includes(program)) {
    let files = 0;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (program === "wc" && /^-[lwc]+$/.test(arg)) continue;
      if (program !== "wc" && arg === "-n" && /^\d+$/.test(rest[i + 1] ?? "")) { i++; continue; }
      if (arg.startsWith("-") || taskPathReason(arg, cwd, true)) return ask("unrecognized inspection option or file outside scope");
      files++;
    }
    if (files) return allowed;
  }
  // These are NOT safe commands. Offer an explicit, task-lifetime grant because tests execute
  // project code (including changed code), with the user's full filesystem/network permissions.
  if ((program === "npm" && rest.length === 2 && rest[0] === "run" && ["check", "test", "lint", "typecheck"].includes(rest[1])) ||
      (program === "node" && rest[0] === "--test" && rest.length > 1 && rest.slice(1).every(p => !p.startsWith("-") && /\.(?:mjs|cjs|js|ts)$/.test(p) && !taskPathReason(p, cwd, true)))) {
    return { action: "test", reason: "executes project code; may write outside the project or access the network" };
  }
  return ask("script, mutation, network operation, or unrecognized command");
}
