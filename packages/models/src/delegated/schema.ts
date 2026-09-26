import { z } from "zod";
import type { ToolCall, ToolDefinition } from "../types.js";

// Tool calling over structured output. The delegated CLIs have their own tools
// turned off, so our tools can't be real tools there. Instead the reply must
// match a JSON Schema: `{ toolCalls: [{ name, input }], text }`, where each item
// is one of our tools with that tool's own input schema. The reply is turned
// back into ToolCall[] so callers see no difference.

const TOOL_INSTRUCTIONS =
  "Reply only with JSON matching the given schema. To use a tool, put it in toolCalls as { name, input } with that tool's input. Put any short note in text.";

const OBJECT_INSTRUCTIONS = "Reply only with JSON matching the given schema.";

export interface DelegatedShape {
  /** The JSON Schema given to the CLI. */
  schema: Record<string, unknown>;
  /** Appended to the system prompt. */
  instructions: string;
  mode: "tools" | "object" | "text";
}

export function replySchema(
  tools: readonly ToolDefinition[] | undefined,
  output: z.ZodType | undefined,
): DelegatedShape {
  if (tools?.length) {
    return {
      mode: "tools",
      instructions: TOOL_INSTRUCTIONS,
      schema: {
        type: "object",
        properties: {
          toolCalls: {
            type: "array",
            items: {
              anyOf: tools.map((tool) => ({
                type: "object",
                description: tool.description,
                properties: { name: { type: "string", const: tool.name }, input: tool.parameters },
                required: ["name", "input"],
                additionalProperties: false,
              })),
            },
          },
          text: { type: "string" },
        },
        required: ["toolCalls"],
        additionalProperties: false,
      },
    };
  }
  if (output) {
    const schema = z.toJSONSchema(output, { target: "draft-7" }) as Record<string, unknown>;
    delete schema.$schema;
    return { mode: "object", instructions: OBJECT_INSTRUCTIONS, schema };
  }
  return {
    mode: "text",
    instructions: OBJECT_INSTRUCTIONS,
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

export type ParsedReply =
  | { ok: true; text: string; toolCalls: ToolCall[]; object: unknown }
  | { ok: false; error: string; raw: string };

/** Turns the CLI's structured reply back into our result shape. */
export function parseReply(
  value: unknown,
  shape: DelegatedShape,
  tools: readonly ToolDefinition[] | undefined,
): ParsedReply {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let json: unknown = value;
  if (typeof value === "string") {
    try {
      json = JSON.parse(value);
    } catch {
      return { ok: false, error: "The reply was not JSON.", raw };
    }
  }
  if (json === null || typeof json !== "object")
    return { ok: false, error: "The reply was not a JSON object.", raw };
  const reply = json as { toolCalls?: unknown; text?: unknown };
  if (shape.mode === "object") return { ok: true, text: "", toolCalls: [], object: json };
  const text = typeof reply.text === "string" ? reply.text : "";
  if (shape.mode === "text") {
    if (typeof reply.text !== "string") return { ok: false, error: "The reply had no text.", raw };
    return { ok: true, text, toolCalls: [], object: undefined };
  }
  if (!Array.isArray(reply.toolCalls))
    return { ok: false, error: "The reply had no toolCalls array.", raw };
  const names = new Set((tools ?? []).map((t) => t.name));
  const toolCalls: ToolCall[] = [];
  for (const [index, item] of reply.toolCalls.entries()) {
    const call = item as { name?: unknown; input?: unknown };
    if (typeof call?.name !== "string" || !names.has(call.name)) {
      return { ok: false, error: `toolCalls[${index}] names no known tool.`, raw };
    }
    toolCalls.push({ id: `call-${index + 1}`, name: call.name, input: call.input ?? {} });
  }
  return { ok: true, text, toolCalls, object: undefined };
}

export interface PromptImage {
  mediaType: string;
  /** Base64. */
  data: string;
}

export interface DelegatedPrompt {
  text: string;
  images: PromptImage[];
}

const toBase64 = (data: unknown): string => {
  if (typeof data === "string") return data.replace(/^data:[^,]*,/, "");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64");
  return "";
};

/**
 * Flattens a conversation (the AI SDK message shapes the client already built)
 * into one prompt: earlier turns as labelled text, images kept aside for the CLI's
 * own image input.
 */
export function flattenMessages(messages: readonly unknown[]): DelegatedPrompt {
  const parts: string[] = [];
  const images: PromptImage[] = [];
  const single = messages.length === 1;
  for (const message of messages as Array<{ role: string; content: unknown }>) {
    const label =
      message.role === "assistant"
        ? "Assistant"
        : message.role === "tool"
          ? "Tool results"
          : "User";
    const chunks: string[] = [];
    if (typeof message.content === "string") chunks.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
        else if (
          (part.type === "file" || part.type === "image") &&
          typeof part.mediaType === "string"
        ) {
          const data = toBase64(part.data ?? part.image);
          if (data && part.mediaType.startsWith("image/")) {
            images.push({ mediaType: part.mediaType, data });
            chunks.push(`[image ${images.length} attached]`);
          }
        } else if (part.type === "tool-call") {
          chunks.push(`toolCall ${String(part.toolName)} ${JSON.stringify(part.input ?? {})}`);
        } else if (part.type === "tool-result") {
          chunks.push(
            `result of ${String(part.toolName)}: ${JSON.stringify((part.output as { value?: unknown })?.value ?? part.output ?? null)}`,
          );
        }
      }
    }
    const body = chunks.join("\n");
    parts.push(single ? body : `${label}:\n${body}`);
  }
  return { text: parts.join("\n\n"), images };
}
