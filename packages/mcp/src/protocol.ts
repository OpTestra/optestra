import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// A minimal MCP server over stdio (AGT-1): JSON-RPC 2.0, one message per line
// (the MCP stdio transport). Only what a tools-and-resources server needs:
// initialize, ping, tools/list, tools/call, resources/list, resources/read.
// Hand-written rather than the SDK: the surface is small, it adds no
// dependency (and no HTTP server code) to a package that must stay local-only,
// and the protocol tests below pin every message.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

export const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface ResourceSpec {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
}

export interface ServerDefinition {
  name: string;
  version: string;
  instructions?: string;
  tools: ToolSpec[];
  resources: ResourceSpec[];
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  readResource(uri: string): Promise<{ text: string; mimeType: string } | undefined>;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Handles one parsed message; returns the response, or undefined for a notification. */
export function createHandler(server: ServerDefinition) {
  const inflight = new Map<JsonRpcId, AbortController>();

  async function dispatch(method: string, params: Record<string, unknown>, id: JsonRpcId) {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
          ? (asked as string)
          : LATEST_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version },
          ...(server.instructions ? { instructions: server.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: server.tools };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") throw new RpcError(ERRORS.invalidParams, "name is required");
        if (!server.tools.some((tool) => tool.name === name))
          throw new RpcError(ERRORS.invalidParams, `Unknown tool: ${name}`);
        const args = params.arguments ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args))
          throw new RpcError(ERRORS.invalidParams, "arguments must be an object");
        const controller = new AbortController();
        inflight.set(id, controller);
        try {
          return await server.callTool(name, args as Record<string, unknown>, controller.signal);
        } finally {
          inflight.delete(id);
        }
      }
      case "resources/list":
        return { resources: server.resources };
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read": {
        const uri = params.uri;
        if (typeof uri !== "string") throw new RpcError(ERRORS.invalidParams, "uri is required");
        const found = await server.readResource(uri);
        if (!found) throw new RpcError(ERRORS.invalidParams, `Unknown resource: ${uri}`);
        return { contents: [{ uri, mimeType: found.mimeType, text: found.text }] };
      }
      default:
        throw new RpcError(ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  return async function handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message))
      return error(null, ERRORS.invalidRequest, "Invalid request");
    const request = message as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
    // A response from the client (we send no requests): ignore.
    if (request.method === undefined && ("result" in request || "error" in request))
      return undefined;
    const id = request.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string")
      return error(hasId ? id : null, ERRORS.invalidRequest, "Invalid request");
    if (!hasId) {
      // Notifications: initialized, cancelled; nothing to answer.
      if (request.method === "notifications/cancelled") {
        const target = (request.params as { requestId?: JsonRpcId } | undefined)?.requestId;
        if (target !== undefined) inflight.get(target)?.abort();
      }
      return undefined;
    }
    const params = request.params ?? {};
    if (typeof params !== "object" || Array.isArray(params))
      return error(id, ERRORS.invalidParams, "params must be an object");
    try {
      return { jsonrpc: "2.0", id, result: await dispatch(request.method, params, id) };
    } catch (caught) {
      if (caught instanceof RpcError) return error(id, caught.code, caught.message);
      return error(id, ERRORS.internal, caught instanceof Error ? caught.message : String(caught));
    }
  };
}

function error(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Serves over a pair of streams (stdin/stdout): one JSON message per line in,
 * one per line out. Requests run concurrently; answers go out as they finish.
 * Resolves when the input ends and every answer is written.
 */
export function serveStreams(
  server: ServerDefinition,
  input: Readable,
  output: Writable,
): Promise<void> {
  const handle = createHandler(server);
  const pending = new Set<Promise<void>>();
  const send = (response: JsonRpcResponse) => {
    output.write(`${JSON.stringify(response)}\n`);
  };
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(error(null, ERRORS.parse, "Parse error"));
      return;
    }
    const task = handle(message).then((response) => {
      if (response) send(response);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  return new Promise((resolve) => {
    lines.on("close", () => {
      void Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
