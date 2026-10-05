import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { RpcProcess } from "../../lib/rpc-process.ts";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/** MCP stdio only: no sampling, elicitation, or host execution requests from servers. */
export class McpConnection {
  readonly rpc: RpcProcess;
  readonly tools: McpTool[] = [];
  private ready?: Promise<void>;

  constructor(rpc: RpcProcess) { this.rpc = rpc; }

  start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.ready ??= this.initialize(signal);
    return this.ready;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    this.rpc.start();
    await this.rpc.request("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi", version: "1" },
    }, { signal });
    this.rpc.notify("notifications/initialized", {});
    await this.refreshTools(signal);
  }

  private async refreshTools(signal?: AbortSignal): Promise<void> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const names = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc.request("tools/list", cursor ? { cursor } : {}, { signal }) as { tools: McpTool[]; nextCursor?: string };
      if (!Array.isArray(result?.tools) || result.tools.some(tool => typeof tool?.name !== "string")) throw new Error("Invalid MCP tool list");
      for (const tool of result.tools) {
        if (names.has(tool.name)) throw new Error("Ambiguous MCP tool name");
        names.add(tool.name);
      }
      tools.push(...result.tools);
      if (tools.length > 1000) throw new Error("MCP tool list exceeds limit");
      cursor = result.nextCursor;
      if (!cursor) { this.tools.splice(0, this.tools.length, ...tools); return; }
    }
    throw new Error("MCP tool pagination exceeds limit");
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, beforeCall?: () => void): Promise<AgentToolResult> {
    await this.start(signal);
    // Revalidate consent after startup/discovery, immediately before dispatch. A live server
    // may change its tool declarations while the human is deciding; never reuse that grant.
    if (beforeCall && name !== "help") await this.refreshTools(signal);
    beforeCall?.();
    signal?.throwIfAborted();
    if (name === "help") {
      const selected = args.name === undefined ? undefined : this.tools.find(tool => tool.name === args.name);
      if (args.name !== undefined && !selected) throw new Error(`Unknown MCP tool: ${args.name}`);
      const text = selected ? JSON.stringify(selected, null, 2) : `${this.tools.length} tools:\n${this.tools.map(tool => `${tool.name}: ${(tool.description ?? "").split(/\.\s|\n/)[0].slice(0, 110)}`).join("\n")}`;
      return { content: [{ type: "text", text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n[truncated; request a named tool]` : text }], details: undefined };
    }
    if (!this.tools.some(tool => tool.name === name)) throw new Error(`Unknown MCP tool: ${name}`);
    const result = await this.rpc.request("tools/call", { name, arguments: args }, { signal }) as { content?: Record<string, unknown>[]; isError?: boolean };
    if (!Array.isArray(result?.content)) throw new Error("Invalid MCP result");
    const content: AgentToolResult["content"] = result.content.map(item => {
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") return { type: "image", data: item.data, mimeType: item.mimeType };
      return { type: "text", text: (typeof item.text === "string" ? item.text : JSON.stringify(item)).slice(0, 60_000) };
    });
    if (result.isError) throw new Error(content.map(item => item.type === "text" ? item.text : "[image]").join("\n"));
    return { content, details: undefined };
  }
}
