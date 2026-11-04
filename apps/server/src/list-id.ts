/**
 * `List-Id` arrives bracketed (`<list.corp.com>`) and may differ in case between
 * messages. Normalise once, in one place, so the value an email reports is the
 * exact key a "remember this list" decision is stored under.
 */
export const normalizeListId = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.replace(/[<>]/g, "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};
