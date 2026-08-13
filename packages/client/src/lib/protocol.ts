import {
  type ClientMessage,
  clientMessageSchema,
  type ServerMessage,
  serverMessageSchema,
} from "@zashiki/shared";

/** Validate against the schema before sending and serialize to JSON (validated on both ends). */
export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(clientMessageSchema.parse(msg));
}

/**
 * Safely decode a server→client message.
 * Returns null for invalid JSON, schema violations, or non-string input (does not drop the connection).
 */
export function decodeServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const result = serverMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
