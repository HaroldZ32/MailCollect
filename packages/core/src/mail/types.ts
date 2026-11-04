import type { MailProvider, RawEmail, SyncCursor } from "@mailcollect/shared";

/** Why a mailbox operation failed. Adapters must map vendor errors onto these. */
export type MailErrorCode =
  | "auth"
  | "network"
  | "protocol"
  | "not_supported"
  | "rate_limited";

export class MailError extends Error {
  override readonly name = "MailError";
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly retryable: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  /** Resume position. `undefined` means "first sync" and adapters fetch a bounded window. */
  since?: SyncCursor | undefined;
  /** Hard cap on messages returned by this call. */
  limit?: number;
  /** Called with the running count so the server can push SSE progress. */
  onProgress?: (fetched: number) => void;
  signal?: AbortSignal;
}

export interface FetchResult {
  emails: RawEmail[];
  /** Next resume position; null when the source is exhausted. */
  cursor: SyncCursor | null;
  /** True when the adapter stopped early because of `limit`. */
  hasMore: boolean;
}

/**
 * Device-code prompt the adapter must surface to the user.
 * It is not a credential, but it must never be written to a log.
 */
export interface DeviceCodeNotice {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly message: string;
  readonly expiresInSeconds: number;
}

/**
 * One mailbox, one adapter. Implementations live in this directory:
 * `imap.ts`, `pop3.ts`, `graph.ts`. FROZEN CONTRACT — do not widen.
 */
export interface MailSource {
  readonly provider: MailProvider;
  /** Validate credentials and report server identity. Fetches no messages. */
  verify(): Promise<{ ok: boolean; detail: string }>;
  /** Fetch new messages since `options.since`. */
  fetch(options?: FetchOptions): Promise<FetchResult>;
  /**
   * Optional push notification. Returns an unsubscribe function, or null when
   * the provider has no push capability (POP3).
   */
  watch?(onNew: () => void): Promise<(() => void) | null>;
  /**
   * Optional interactive login (device-code flow). Only adapters that need a
   * user gesture implement it (Microsoft Graph); IMAP/POP3 leave it undefined.
   * The prompt goes to `onDeviceCode` and to the adapter's own
   * `lastDeviceCodeNotice` accessor, and is never logged.
   */
  login?(onDeviceCode?: (notice: DeviceCodeNotice) => void): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export type MailSourceFactory = (account: {
  id: string;
  provider: MailProvider;
  email: string;
  config: Record<string, string>;
  secret: string;
}) => MailSource;
