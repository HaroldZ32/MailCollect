/**
 * SQLite `LIKE` wildcard escaping for local search.
 *
 * A user searching `%` (or `_`) meant the literal character, not "match
 * everything". Every search predicate binds `escapeLike(query)` inside
 * `%...%` and appends `ESCAPE '\\'`, so `\`, `%` and `_` match themselves.
 */
export const LIKE_ESCAPE = "ESCAPE '\\'";

export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Binds a `%contains%` pattern for a column compared with `LIKE ? ESCAPE '\\'`. */
export const containsLike = (value: string): string => `%${escapeLike(value)}%`;
