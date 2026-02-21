import type {
  MarkdownIR,
  MarkdownLinkSpan,
  IRRenderer,
  StyleMarker,
  RenderedLink,
} from "../markdown/index.js";
import { markdownToIR, chunkIR } from "../markdown/index.js";

// ===== HTML Escaping =====

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// ===== Telegram Renderer (implements IRRenderer) =====

const telegramRenderer: IRRenderer = {
  styleMarkers: {
    bold: { open: "<b>", close: "</b>" },
    italic: { open: "<i>", close: "</i>" },
    strikethrough: { open: "<s>", close: "</s>" },
    code: { open: "<code>", close: "</code>" },
    code_block: { open: "<pre><code>", close: "</code></pre>" },
    spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
    blockquote: { open: "<blockquote>", close: "</blockquote>" },
  },

  escapeText: escapeHtml,

  buildLink(link: MarkdownLinkSpan, fullText: string): RenderedLink | null {
    const href = link.href.trim();
    if (!href || link.start === link.end) return null;
    return {
      start: link.start,
      end: link.end,
      open: `<a href="${escapeHtmlAttr(href)}">`,
      close: "</a>",
    };
  },
};

// ===== Render IR → string using renderer =====

/**
 * Universal renderer: walks IR and inserts markers from renderer.
 * Used by all channels (Telegram, Discord, Signal...).
 *
 * Algorithm (boundary-walking like Clawdbot's renderMarkdownWithMarkers):
 * 1. Collect all boundary points (start/end positions of styles and links)
 * 2. Sort boundary points
 * 3. Walk text between boundaries, inserting open/close markers
 * 4. Stack ensures proper LIFO close order (for nested styles)
 */
function renderIR(ir: MarkdownIR, renderer: IRRenderer): string {
  const { text, styles, links } = ir;
  const { styleMarkers, escapeText, buildLink } = renderer;

  // Filter styles with available markers
  const activeStyles = styles.filter((s) => styleMarkers[s.style]);

  // Build links
  const activeLinks: RenderedLink[] = [];
  if (buildLink) {
    for (const link of links) {
      const rendered = buildLink(link, text);
      if (rendered) activeLinks.push(rendered);
    }
  }

  // Collect all boundary positions
  const boundaries = new Set<number>([0, text.length]);
  for (const s of activeStyles) {
    boundaries.add(s.start);
    boundaries.add(s.end);
  }
  for (const l of activeLinks) {
    boundaries.add(l.start);
    boundaries.add(l.end);
  }
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);

  // Stack for open markers
  const stack: Array<{ close: string; end: number }> = [];
  let result = "";

  for (let i = 0; i < sortedBoundaries.length; i++) {
    const pos = sortedBoundaries[i];

    // 1. Close styles/links ending at this position (LIFO)
    while (stack.length > 0 && stack[stack.length - 1].end === pos) {
      result += stack.pop()!.close;
    }

    // 2. Open styles/links starting at this position
    // Sort: larger end first (outer container opens first)
    const openings: Array<{ open: string; close: string; end: number }> = [];

    for (const s of activeStyles) {
      if (s.start === pos) {
        const marker = styleMarkers[s.style]!;
        openings.push({ open: marker.open, close: marker.close, end: s.end });
      }
    }
    for (const l of activeLinks) {
      if (l.start === pos) {
        openings.push({ open: l.open, close: l.close, end: l.end });
      }
    }

    // Outer (larger end) opens first → closes last (LIFO)
    openings.sort((a, b) => b.end - a.end);

    for (const o of openings) {
      result += o.open;
      stack.push({ close: o.close, end: o.end });
    }

    // 3. Append escaped text until next boundary
    const nextPos = sortedBoundaries[i + 1];
    if (nextPos !== undefined && nextPos > pos) {
      const segment = text.slice(pos, nextPos);
      // Don't escape inside code/code_block
      const inCode = stack.some(
        (s) => s.close === "</code>" || s.close === "</code></pre>",
      );
      result += inCode ? segment : escapeText(segment);
    }
  }

  // Close remaining stack
  while (stack.length > 0) {
    result += stack.pop()!.close;
  }

  return result;
}

// ===== Public API =====

/** Markdown → Telegram HTML (full pipeline) */
export function markdownToTelegramHtml(markdown: string): string {
  const ir = markdownToIR(markdown, { linkify: true, headingStyle: "bold" });
  return renderIR(ir, telegramRenderer);
}

/** Markdown → Telegram HTML chunks (for long messages) */
export function markdownToTelegramChunks(
  markdown: string,
  maxLength: number = 4096,
): Array<{ html: string; text: string }> {
  const ir = markdownToIR(markdown, { linkify: true, headingStyle: "bold" });
  const chunks = chunkIR(ir, { maxLength });
  return chunks.map((chunk) => ({
    html: renderIR(chunk, telegramRenderer),
    text: chunk.text,
  }));
}

/** Strip all HTML tags — for plain text fallback */
export function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}
