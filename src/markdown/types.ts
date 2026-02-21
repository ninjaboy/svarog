/** Supported formatting styles */
export type MarkdownStyle =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "code_block"
  | "spoiler"
  | "blockquote";

/** Style span — a range of characters with a specific style */
export interface MarkdownStyleSpan {
  start: number;
  end: number;
  style: MarkdownStyle;
}

/** Link span — a range of characters that is a hyperlink */
export interface MarkdownLinkSpan {
  start: number;
  end: number;
  href: string;
}

/**
 * Intermediate Representation of a document.
 * Contains plain text + arrays of styles and links with positions.
 * Channel-agnostic — equally suitable for Telegram, Discord, Signal, etc.
 */
export interface MarkdownIR {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
}

export interface MarkdownParseOptions {
  linkify?: boolean;
  headingStyle?: "none" | "bold";
  enableSpoilers?: boolean;
}

export type ChunkBreakPreference = "paragraph" | "newline" | "sentence";

export interface ChunkOptions {
  maxLength: number;
  breakPreference?: ChunkBreakPreference[];
}

/** Open/close markers for a style */
export interface StyleMarker {
  open: string;
  close: string;
}

/** Rendered link with open/close markers */
export interface RenderedLink {
  start: number;
  end: number;
  open: string;
  close: string;
}

/**
 * Channel renderer interface.
 * Each channel (Telegram, Discord, Signal...) implements this interface.
 */
export interface IRRenderer {
  styleMarkers: Partial<Record<MarkdownStyle, StyleMarker>>;
  escapeText(text: string): string;
  buildLink?(link: MarkdownLinkSpan, fullText: string): RenderedLink | null;
}
