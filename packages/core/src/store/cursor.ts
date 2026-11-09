/**
 * Pagination cursor for the email list: `base64url("<sentAt>|<id>")`.
 *
 * Shared by `listEmails` (all folders) and `listEmailsInFolder` (v1.1) so the two
 * listings cannot drift apart.
 */
export interface EmailCursor {
  readonly sentAt: string;
  readonly id: string;
}

export const encodeCursor = (sentAt: string, id: string): string =>
  Buffer.from(`${sentAt}|${id}`, "utf8").toString("base64url");

export function decodeCursor(cursor: string): EmailCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf("|");
    if (idx < 0) return null;
    return { sentAt: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}
