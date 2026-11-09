/**
 * Typed persistence errors.
 *
 * The store is the trust boundary for local data: a caller (HTTP route, worker,
 * sync engine) must be able to tell "you sent something invalid" from "that row
 * does not exist" from "the current state forbids this" without parsing English
 * text. `code` is what the server's error mapper switches on.
 */
export type StoreErrorCode = "conflict" | "not_found" | "invalid" | "state";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}
