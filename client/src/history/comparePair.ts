export function chooseComparePair(ids: readonly string[], selected: string): { a: string; b: string | null } | null {
  if (!ids.includes(selected)) return null;
  return { a: selected, b: ids.find(id => id !== selected) ?? null };
}
