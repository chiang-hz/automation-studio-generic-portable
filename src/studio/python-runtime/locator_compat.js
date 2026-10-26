/* Selenium adapter for Automation Studio role, label, placeholder and text locators.
 * Runs inside the currently selected frame; no Node or third-party JS dependencies.
 * root is Document or Element. Uses the same CSS polyfill as data extraction.
 */
(root, rule, css) => {
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const strategy = rule.strategy || 'css';
  const value = normalize(rule.value);
  const exact = rule.exact === true;
  const matches = candidate => exact ? normalize(candidate) === value : normalize(candidate).toLowerCase().includes(value.toLowerCase());
  const all = (query) => Array.from(root.querySelectorAll(query));
  const unique = values => [...new Set(values.filter(Boolean))];
  if (strategy === 'css') return css(root, rule.value);
  if (strategy === 'name') return all('[name]').filter(e => e.getAttribute('name') === rule.value);
  if (strategy === 'testId') return all('[data-testid]').filter(e => e.getAttribute('data-testid') === rule.value);
  if (strategy === 'placeholder') return all('[placeholder]').filter(e => matches(e.getAttribute('placeholder')));
  const text = e => normalize(e.innerText || e.textContent);
  if (strategy === 'text') return all('body *').filter(e => {
    if (!matches(text(e))) return false;
    return ![...e.children].some(child => matches(text(child)));
  });
  if (strategy === 'label') {
    const controls = all('input,select,textarea,button,[aria-labelledby],[aria-label]');
    return controls.filter(el => {
      const labels = Array.from(el.labels || []).map(e => text(e));
      const reference = normalize(el.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
      const names = [...labels, el.getAttribute('aria-label') || '', ...reference.map(id => root.ownerDocument?.getElementById(id)?.textContent || (root.getElementById?.(id)?.textContent || ''))];
      return names.some(matches);
    });
  }
  if (strategy !== 'role') throw Error('Unsupported Selenium locator strategy: ' + strategy);
  const targetRole = normalize(rule.role || 'button').toLowerCase();
  const role = el => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && ['button','reset','submit','image'].includes(type))) return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea' || (tag === 'input' && ['text','search','email','tel','url','password','number',''].includes(type))) return 'textbox';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'option') return 'option';
    if (tag === 'img') return 'img';
    if (tag === 'h1' || /^h[2-6]$/.test(tag)) return 'heading';
    return '';
  };
  const accessibleName = el => {
    const labelledby = normalize(el.getAttribute('aria-labelledby'));
    if (labelledby) {
      const doc = el.ownerDocument;
      const parts = labelledby.split(' ').map(id => doc.getElementById(id)?.textContent || '').filter(Boolean);
      if (parts.length) return normalize(parts.join(' '));
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return normalize(ariaLabel);
    const labels = el.labels ? Array.from(el.labels).map(e=>text(e)) : [];
    if (labels.length) return normalize(labels.join(' '));
    if (el.tagName === 'IMG' && el.getAttribute('alt')) return normalize(el.getAttribute('alt'));
    if (el.tagName === 'INPUT' && el.getAttribute('value')) return normalize(el.getAttribute('value'));
    return text(el) || normalize(el.getAttribute('title'));
  };
  return unique(all('*').filter(el => !el.closest('[aria-hidden="true"],[inert],[hidden]') && role(el) === targetRole && (value === '' || matches(accessibleName(el)))));
}
