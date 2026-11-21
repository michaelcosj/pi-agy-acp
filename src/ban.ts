// Google's account-suspension notice. agy sends it as normal reply text (or
// as an error), so Pi must look for it: after a ban, more requests do no good.

const NOTICE = /disabled in this account for violation of Terms of Service|\bTOS_VIOLATION\b/i;

/** Whether text holds the suspension notice. Short replies only, so a model that quotes it in a long answer does not count. */
export function isBanNotice(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return t.length < 2_000 && NOTICE.test(t);
}

export const BANNED =
  "Google disabled Antigravity on this account (403 TOS_VIOLATION). pi-agy-acp stopped all Antigravity turns and Pi child agents. " +
  "Stop using this account with third-party tools. The only remedy is Google's appeal form (one appeal per account).";
