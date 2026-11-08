/**
 * Extract plain text from a PDF buffer (Phase 7 ingestion). Imports the parser's
 * internal entrypoint to avoid pdf-parse's debug harness that runs when its
 * package index is imported directly.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as {
    default: (data: Buffer) => Promise<{ text: string }>;
  };
  const parsed = await mod.default(buffer);
  return parsed.text;
}
