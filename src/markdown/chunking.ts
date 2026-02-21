import type { MarkdownIR, MarkdownStyleSpan, MarkdownLinkSpan, ChunkOptions } from "./types.js";

/**
 * Split IR into chunks not exceeding maxLength.
 * Styles and links are correctly clipped and offset-shifted per chunk.
 * Code blocks (code_block style) are never split.
 */
export function chunkIR(ir: MarkdownIR, options: ChunkOptions): MarkdownIR[] {
  const { maxLength, breakPreference = ["paragraph", "newline", "sentence"] } = options;

  if (ir.text.length <= maxLength) return [ir];

  const chunks: MarkdownIR[] = [];
  let offset = 0;

  while (offset < ir.text.length) {
    let end = Math.min(offset + maxLength, ir.text.length);

    if (end < ir.text.length) {
      // Check if we're inside a code_block
      const codeBlockSpan = ir.styles.find(
        (s) => s.style === "code_block" && s.start < end && s.end > end,
      );
      if (codeBlockSpan) {
        // Option A: code block fits — shift end past it
        if (codeBlockSpan.end - offset <= maxLength) {
          end = codeBlockSpan.end;
        } else {
          // Option B: code block doesn't fit — cut before it
          end = codeBlockSpan.start;
        }
      }

      // Find break point
      if (end > offset && end < ir.text.length) {
        end = findBreakPoint(ir.text, offset, end, breakPreference);
      }
    }

    // Prevent empty chunks
    if (end <= offset) end = offset + maxLength;

    // Extract chunk
    const rawSlice = ir.text.slice(offset, end);
    const chunkText = rawSlice.replace(/^\n+/, "");
    const chunkOffset = offset + (rawSlice.length - chunkText.length);

    chunks.push({
      text: chunkText,
      styles: sliceSpans(ir.styles, chunkOffset, end),
      links: sliceSpans(ir.links, chunkOffset, end),
    });

    offset = end;
    // Skip leading newlines
    while (offset < ir.text.length && ir.text[offset] === "\n") offset++;
  }

  return chunks;
}

/** Find the best break point in text */
function findBreakPoint(
  text: string,
  start: number,
  maxEnd: number,
  preferences: string[],
): number {
  const search = text.slice(start, maxEnd);

  for (const pref of preferences) {
    let idx = -1;
    if (pref === "paragraph") idx = search.lastIndexOf("\n\n");
    else if (pref === "newline") idx = search.lastIndexOf("\n");
    else if (pref === "sentence") {
      const match = search.match(/[.!?]\s/g);
      if (match) {
        idx = search.lastIndexOf(match[match.length - 1]);
        if (idx !== -1) idx += match[match.length - 1].length;
      }
    }
    // Break point is valid if it's in the upper half of the chunk
    if (idx !== -1 && idx >= (maxEnd - start) / 2) {
      return start + idx;
    }
  }

  return maxEnd;
}

/**
 * Clip and offset-shift a span array for chunk [start, end).
 * Spans crossing boundaries are clamped.
 * Positions are shifted relative to chunk start.
 */
function sliceSpans<T extends { start: number; end: number }>(
  spans: T[],
  start: number,
  end: number,
): T[] {
  const result: T[] = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    result.push({
      ...span,
      start: Math.max(0, span.start - start),
      end: Math.min(end - start, span.end - start),
    });
  }
  return result;
}
