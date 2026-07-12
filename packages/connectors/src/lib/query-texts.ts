/** Expand a search into independent query strings. Never joins all terms into one strict AND query. */
export function resolveQueryTexts(query: { readonly terms: readonly string[]; readonly queryText?: string }): string[] {
  if (query.queryText?.trim()) return [query.queryText.trim()];
  return query.terms.map((term) => term.trim()).filter(Boolean);
}
