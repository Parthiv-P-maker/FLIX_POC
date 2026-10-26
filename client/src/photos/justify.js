// Photos still being processed have no dimensions yet. 3:2 is the commonest
// camera ratio, so an un-probed cell lands close and does not jump far.
const FALLBACK_ASPECT = 1.5;

export const aspectOf = (p) => (p.width && p.height ? p.width / p.height : FALLBACK_ASPECT);

/** Row geometry shrinks with the viewport: 200px rows on a phone are huge. */
function rowMetrics(containerWidth) {
  if (containerWidth < 520) return { target: 120, gap: 6 };
  if (containerWidth < 900) return { target: 160, gap: 8 };
  return { target: 210, gap: 10 };
}

/**
 * Greedy justified rows, the shape Flickr and Google Photos use. Photos are
 * packed at a nominal height until they overflow, then the row's height is
 * solved so it fills the width exactly. Every photo keeps its aspect ratio.
 */
export function justify(photos, containerWidth) {
  const { target, gap } = rowMetrics(containerWidth);
  const rows = [];
  let row = [];
  let aspectSum = 0;

  for (const photo of photos) {
    row.push(photo);
    aspectSum += aspectOf(photo);
    const gaps = gap * (row.length - 1);
    if (aspectSum * target + gaps >= containerWidth) {
      rows.push({ items: row, height: (containerWidth - gaps) / aspectSum, gap });
      row = [];
      aspectSum = 0;
    }
  }
  // The trailing row stays at the target height: one leftover photo blown
  // up to full width looks like a bug.
  if (row.length) rows.push({ items: row, height: target, gap });
  return rows;
}

/**
 * Fold a newly-fetched page into the groups on screen. A month usually
 * straddles a page boundary, so page 2's first group is often page 1's last;
 * appending blindly would render that month header twice.
 */
export function mergeGroups(existing, incoming) {
  const out = existing.map((g) => ({ ...g, items: [...g.items] }));
  const byKey = new Map(out.map((g) => [g.key, g]));
  for (const group of incoming) {
    const current = byKey.get(group.key);
    if (current) current.items.push(...group.items);
    else { byKey.set(group.key, group); out.push(group); }
  }
  return out;
}
