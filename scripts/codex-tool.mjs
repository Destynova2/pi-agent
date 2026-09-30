#!/usr/bin/env node
// Runs only behind codex-shell.mjs. Reuse Pi's tools, including edit validation and images.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const names = { read: "createReadTool", write: "createWriteTool", edit: "createEditTool", ls: "createLsTool", find: "createFindTool", grep: "createGrepTool" };
try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  if (!Object.hasOwn(names, request.name)) throw new Error("Unsupported sandbox tool");
  const sdk = await import(pathToFileURL(process.argv[2]).href);
  const tool = sdk[names[request.name]](process.cwd());
  const result = await tool.execute(request.id, request.input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
