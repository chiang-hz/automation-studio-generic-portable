/* Disambiguate exact-name dropdown options within the ACTIVE popup.
 * Called with (candidates: Element[], lastOpenedTrigger?: Element).
 * Do not silently select the first matching option. If no reliable owner or
 * interactability signal reduces the candidates to one, remain ambiguous.
 */
(candidates, lastOpenedTrigger) => {
  let items = [...new Set(candidates)].filter(el => el?.isConnected);
  const result = (reason) => ({elements: items, reason,
    detail: items.slice(0, 5).map(el => {
      const popup = el.closest('[role="listbox"],[role="menu"],[data-radix-select-content],[cmdk-list]');
      const box = el.getBoundingClientRect();
      return {tag: el.tagName.toLowerCase(), id: el.id || '', popup: popup?.id || '',
        state: popup?.getAttribute('data-state') || '',
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]};
    })});
  if (items.length <= 1) return result('already unique');
  // Playwright getByRole() ignores elements hidden from the accessibility tree.
  const exposed = items.filter(el => !el.closest('[aria-hidden="true"],[inert],[hidden],[data-state="closed"]'));
  if (exposed.length === 1) { items = exposed; return result('accessibility-visible option'); }
  if (exposed.length > 1) items = exposed;
  // ARIA relationship: a combobox's aria-controls / aria-owns points at its
  // listbox, including React/Radix popovers rendered under document.body.
  const controlsFor = trigger => {
    if (!trigger || !trigger.isConnected ||
        !(trigger.matches('[aria-expanded="true"]') || trigger.matches('[data-state="open"]'))) return [];
    return [trigger.getAttribute('aria-controls'), trigger.getAttribute('aria-owns')]
      .filter(Boolean).flatMap(s => s.split(/\s+/).filter(Boolean))
      .map(id => document.getElementById(id)).filter(Boolean);
  };
  const scoped = trigger => {
    const controlled = controlsFor(trigger);
    if (!controlled.length) return [];
    return items.filter(el => controlled.some(popup => popup === el || popup.contains(el)));
  };
  const lastScoped = scoped(lastOpenedTrigger);
  if (lastScoped.length === 1) { items = lastScoped; return result('last-opened combobox controls'); }
  // Do not bypass a recorded active menu if it truly has multiple matching
  // options. Further checks may resolve stacked/obscured clones, but other
  // simultaneously open menus must not contribute candidates.
  if (lastScoped.length > 1) items = lastScoped;
  else if (lastOpenedTrigger?.isConnected && controlsFor(lastOpenedTrigger).length) {
    // Never escape the explicitly opened popup to click another menu's item.
    return result('last-opened combobox has no matching option within its controlled popup');
  } else {
    const expanded = [...document.querySelectorAll('[aria-expanded="true"][aria-controls], [data-state="open"][aria-controls], [aria-expanded="true"][aria-owns]')];
    const scopes = expanded.map(scoped).filter(group => group.length);
    if (scopes.length === 1 && scopes[0].length === 1) {
      items = scopes[0]; return result('unique expanded combobox controls');
    }
    const uniqueAcrossMenus = [...new Set(scopes.flat())];
    if (uniqueAcrossMenus.length === 1) {
      items = uniqueAcrossMenus; return result('unique option in expanded popup');
    }
  }
  // A visibly rendered option may still be covered by another dialog or
  // popup. Restrict to elements reachable through normal pointer hit-testing.
  const hittable = items.filter(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return Boolean(top && (top === el || el.contains(top)));
  });
  if (hittable.length === 1) { items = hittable; return result('only unobscured hit-test target'); }
  // No arbitrary first/last or DOM-order fallback for a unique action.
  return result(`ambiguous active option: ${items.length} candidate(s); ${hittable.length} pointer-hit candidate(s)`);
}
