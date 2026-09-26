/**
 * The one serialisation for contract documents, so a run folded twice is byte
 * for byte the same. Pass documents that went through their schema: key order
 * then follows the schema.
 */
export function serializeDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** One events.ndjson line. */
export function serializeEvent(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}
