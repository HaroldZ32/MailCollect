import type { DeviceCodeNotice } from "@mailcollect/core/mail";
import type { ServerEvent } from "@mailcollect/shared";

/**
 * The interactive-login wiring, extracted from main.ts so it can be tested.
 *
 * A verifier mutated the old inline version back to its buggy shape and the whole
 * suite stayed green — this module exists so that can never happen again.
 */
export interface LoginCapableSource {
  login?: (
    onDeviceCode?: (notice: DeviceCodeNotice) => void,
  ) => Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;
}

export async function runDeviceLogin(
  source: LoginCapableSource,
  accountId: string,
  emit: (event: ServerEvent) => void,
): Promise<void> {
  try {
    if (typeof source.login !== "function") {
      emit({
        type: "device-login",
        data: { accountId, ok: false, detail: "该邮箱类型不支持交互式登录，请用「验证」" },
      });
      return;
    }

    // The callback MUST be handed to login() itself: the adapter always passes
    // its own wrapper down to the auth layer, which shadows any callback given
    // at construction time.
    const result = await source.login((notice) => {
      // MSAL can invoke this before a code exists (client rejected first); an
      // empty payload would open a useless dialog.
      if (!notice?.userCode || !notice.verificationUri) return;
      emit({ type: "device-code", data: { accountId, ...notice } });
    });

    emit({
      type: "device-login",
      data: { accountId, ok: result.ok, detail: result.detail },
    });
  } finally {
    await source.close();
  }
}
