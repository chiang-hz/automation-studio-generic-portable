/** Pure, offline-testable login/navigation helpers. Never open a tab or send credentials. */
export function isPotentialLoginUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /\/(?:login|sign-?in|signin|sso)(?:[/?#]|$)|\/connect\/authorize|\/cdn-cgi\/challenge/i.test(u.pathname + u.search);
  } catch { return false; }
}

export function scoreExistingSiteTab(raw: string, target: string): number {
  try {
    const u = new URL(raw);
    if (u.origin !== new URL(target).origin) return 0;
    if (isPotentialLoginUrl(raw)) return 1;
    if (/^\/(?:404|403|401|error|access-denied)\/?$/i.test(u.pathname)) return 0;
    return u.pathname === '/' ? 10 : 20;
  } catch { return 0; }
}

export function isRequestedUrlAlreadyOpen(current: string, requested: string): boolean {
  try {
    const a = new URL(current);
    const b = new URL(requested);
    return a.href.replace(/\/$/, '') === b.href.replace(/\/$/, '');
  } catch { return false; }
}
