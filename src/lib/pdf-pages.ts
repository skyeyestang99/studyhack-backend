/**
 * Best-effort PDF page count from raw bytes, with no new dependency.
 *
 * Used at UPLOAD time to enforce a per-upload page ceiling, which has to happen
 * before the file enters the ingest queue — ingestion is serialized (agent PR #16,
 * `enqueueIngest` is in-process and the agent cannot be scaled past one instance), so
 * a pathological document delays every other student's uploads behind it. Rejecting
 * after queueing would be too late to protect anyone.
 *
 * Counts `/Type /Page` objects, which is reliable for uncompressed cross-reference
 * tables and unreliable for PDFs that hide their page tree inside object streams.
 * That is why it returns null rather than 0 when it cannot tell: an unknown count
 * must not be treated as a small one.
 *
 * Note this is only the ceiling. Actual OCR work is separately bounded per document by
 * OCR_MAX_PAGES_BY_TYPE in the agent, so this is not the only line of defence — it
 * exists to catch the extreme case, where even text extraction and chunking of a
 * thousand pages would occupy the queue.
 */
export function countPdfPages(bytes: Buffer): number | null {
  // Only look at a bounded prefix+suffix: scanning a 200MB buffer with a regex on the
  // request path would itself be the denial of service.
  const MAX_SCAN = 5 * 1024 * 1024;
  const head = bytes.subarray(0, Math.min(bytes.length, MAX_SCAN)).toString("latin1");
  const tail =
    bytes.length > MAX_SCAN
      ? bytes.subarray(bytes.length - MAX_SCAN).toString("latin1")
      : "";
  const text = head + tail;

  if (!text.startsWith("%PDF") && !head.includes("%PDF")) return null;

  // Prefer an explicit /Count on the page tree root when present.
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) =>
    Number(m[1]),
  );
  if (counts.length > 0) {
    const max = Math.max(...counts);
    if (Number.isFinite(max) && max > 0) return max;
  }

  // Fall back to counting page objects. The negative lookahead avoids matching
  // /Type /Pages (the tree node) as a page.
  const pageObjects = text.match(/\/Type\s*\/Page(?![s])/g);
  if (pageObjects && pageObjects.length > 0) return pageObjects.length;

  // Compressed page tree, or not really a PDF. Unknown, not zero.
  return null;
}
