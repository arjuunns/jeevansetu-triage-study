/**
 * Deterministic, sentence-aware text chunker for guideline ingestion (Phase 7).
 * Splits on paragraph/sentence boundaries and packs into ~`maxChars` windows
 * with a small overlap so retrieval keeps surrounding context. Pure function.
 */
export interface TextChunk {
  index: number;
  content: string;
  approxTokens: number;
}

export function chunkText(text: string, maxChars = 1200, overlapChars = 150): TextChunk[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];

  // Split into sentences while preserving terminators.
  const sentences = clean
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: TextChunk[] = [];
  let buffer = '';

  const flush = () => {
    const content = buffer.trim();
    if (!content) return;
    chunks.push({ index: chunks.length, content, approxTokens: Math.ceil(content.length / 4) });
    // Start next buffer with a tail overlap for context continuity.
    buffer = overlapChars > 0 ? content.slice(-overlapChars) : '';
  };

  for (const sentence of sentences) {
    if (buffer.length + sentence.length + 1 > maxChars && buffer.length > 0) {
      flush();
    }
    buffer += (buffer ? ' ' : '') + sentence;
  }
  flush();

  // Re-index after overlap-seeded buffers so indices are contiguous.
  return chunks.map((c, i) => ({ ...c, index: i }));
}
