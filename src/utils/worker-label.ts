/**
 * Format a human-readable worker label: "#N (summary)" or "#N" if no summary.
 * Truncates summary to ~40 chars.
 */
export function workerLabel(id: number, userSummary?: string | null): string {
  if (!userSummary) return `#${id}`;
  const truncated = userSummary.length > 40 ? userSummary.slice(0, 39) + "…" : userSummary;
  return `#${id} (${truncated})`;
}
