export type {
  MarkdownIR,
  MarkdownStyle,
  MarkdownStyleSpan,
  MarkdownLinkSpan,
  MarkdownParseOptions,
  ChunkOptions,
  ChunkBreakPreference,
  IRRenderer,
  StyleMarker,
  RenderedLink,
} from "./types.js";

export { markdownToIR } from "./ir.js";
export { chunkIR } from "./chunking.js";
