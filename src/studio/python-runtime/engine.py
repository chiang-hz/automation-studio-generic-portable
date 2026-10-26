"""Automation Studio portable Python browser adapters. Python 3.10+.

No node executable is required by Selenium. Playwright Python bundles its own driver;
it may launch a bundled Node runtime even if Node is not separately installed.
"""
from __future__ import annotations
import base64
import io
import zipfile
from email.message import Message
import json
import urllib.request
import urllib.error
from urllib.parse import urljoin
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit, unquote


# Same responsive/mobile exclusions used by the TypeScript element resolver.
_PLAYWRIGHT_CSS_EXTENSIONS = re.compile(r':has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b')

_NON_DESKTOP_SELECTOR = ('[class*="mobile" i],[id*="mobile" i],'
                         '[class*="hamburger" i],[class*="offcanvas" i],'
                         '[class*="drawer" i],[aria-label*="\u624b\u6a5f"],'
                         '[title*="\u624b\u6a5f"]')


class BrowserEngine:
    def __init__(self, project, root, backend):
        self.project = project
        self.root = Path(root)
        self.backend = backend
        self.browser = None
        self.context = None
        self.page = None
        self.playwright = None
        self.external = project.get('browser', {}).get('connectionMode') == 'cdp'
        self.tabs = {}
        self.download_dir = self.root / 'downloads'
        self.download_dir.mkdir(exist_ok=True, parents=True)
        # Chrome's global download path must not point at user-facing artifacts.
        # Only a download action may temporarily redirect to a private staging area.
        self._download_staging_root = self.root / '.local' / 'download-staging'
        self._current = None
        self._profile_lock = None
        self._frame_scope = None
        self._css_helper = None
        self._locator_helper = None
        self._option_helper = None
        self._active_dropdown_trigger = None

    def _profile(self):
        profile = self.root / '.local' / 'profiles' / re.sub(r'[^a-zA-Z0-9._-]', '_', self.project.get('id', 'project'))
        profile.mkdir(parents=True, exist_ok=True)
        if self._profile_lock is None:
            lock = profile.parent / (profile.name + '.in-use.lock')
            try:
                fd = os.open(str(lock), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError as exc:
                raise RuntimeError('Managed profile is already locked. Do not run two workflows on the same profile. Remove a stale .in-use.lock only after all browsers using this profile have exited.') from exc
            os.write(fd, str(os.getpid()).encode('ascii'))
            os.close(fd)
            self._profile_lock = lock
        return profile

    def open(self):
        settings = self.project['browser']
        if self.backend == 'playwright':
            from playwright.sync_api import sync_playwright
            self.playwright = sync_playwright().start()
            if self.external:
                endpoint = _local_cdp(settings.get('cdpEndpoint', 'http://127.0.0.1:9222'))
                self.browser = self.playwright.chromium.connect_over_cdp(endpoint)
                self.context = self.browser.contexts[0]
                if not self.context:
                    raise RuntimeError('CDP browser has no active browser context')
                self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            else:
                opts = {'headless': bool(settings.get('headless', False)), 'accept_downloads': True}
                executable = os.environ.get('CHROME_PATH', '').strip()
                if executable:
                    opts['executable_path'] = executable
                elif settings.get('channel') in ('chrome', 'bundled'):
                    # Prefer the locally installed Chrome, never download Chromium silently.
                    opts['channel'] = 'chrome'
                self.context = self.playwright.chromium.launch_persistent_context(str(self._profile()), **opts)
                self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.page.set_default_timeout(int(settings.get('defaultTimeoutMs', 30000)))
        elif self.backend == 'selenium':
            from selenium import webdriver
            from selenium.webdriver.chrome.options import Options
            from selenium.webdriver.chrome.service import Service
            options = Options()
            if not self.external:
                if settings.get('headless'):
                    options.add_argument('--headless=new')
                options.add_argument('--user-data-dir=' + str(self._profile()))
                options.add_argument('--window-size=1440,900')
            else:
                endpoint = _local_cdp(settings.get('cdpEndpoint', 'http://127.0.0.1:9222'))
                parsed = urlsplit(endpoint)
                options.debugger_address = parsed.netloc
            chrome = os.environ.get('CHROME_PATH', '').strip()
            if chrome and not self.external:
                options.binary_location = chrome
            driver = os.environ.get('CHROMEDRIVER_PATH', '').strip()
            service = Service(executable_path=driver) if driver else Service()
            self.browser = webdriver.Chrome(service=service, options=options)
            self.browser.set_page_load_timeout(max(5, int(settings.get('defaultTimeoutMs', 30000)) // 1000))
            self.page = self.browser
            # Do not override Chrome's download folder at browser startup.
            # Browser-wide routing captures unrelated Chrome component/model
            # downloads (for example CRX3 models named downloads.htm).
        else:
            raise ValueError('Invalid backend')
        if settings.get('stealth') and not self.external:
            print('[BROWSER] Stealth plugin setting does not transfer to Python. Standard Chrome is used; human verification remains required.')
        self.tabs['initial'] = self._tab_id()

    def close(self):
        try:
            self._close_browser()
        finally:
            if self._profile_lock is not None:
                self._profile_lock.unlink(missing_ok=True)
                self._profile_lock = None

    def _close_browser(self):
        # CDP mode must not close the user's existing Chrome browser.
        if self.backend == 'playwright':
            if self.context and not self.external:
                self.context.close()
            if self.browser and self.external:
                self.browser.close()  # disconnect Playwright's CDP transport only
            if self.playwright:
                self.playwright.stop()
        elif self.browser:
            if self.external:
                # Selenium quit detaches from the externally launched browser.
                self.browser.quit()
            else:
                self.browser.quit()

    def _tab_id(self):
        return self.page if self.backend == 'playwright' else self.browser.current_window_handle

    def url(self):
        return self.page.url if self.backend == 'playwright' else self.browser.current_url

    def goto(self, url):
        self._frame_scope = None
        self._active_dropdown_trigger = None
        if self.backend == 'playwright':
            self.page.goto(url, wait_until='domcontentloaded')
        else:
            self.browser.get(url)

    def new_tab(self, name, url):
        self._frame_scope = None
        self._active_dropdown_trigger = None
        if self.backend == 'playwright':
            self.page = self.context.new_page()
        else:
            self.browser.switch_to.new_window('tab')
        if name:
            self.tabs[name] = self._tab_id()
        if url:
            self.goto(url)

    def switch_tab(self, mode, target, index=1):
        self._frame_scope = None
        self._active_dropdown_trigger = None
        if self.backend == 'playwright':
            pages = [p for p in self.context.pages if not p.is_closed()]
            if mode == 'name' and target in self.tabs:
                candidate = self.tabs[target]
                if candidate in pages:
                    self.page = candidate
                    return
            elif mode == 'index' and 0 < index <= len(pages):
                self.page = pages[index-1]
                return
            else:
                for page in pages:
                    if (mode == 'url' and target in page.url) or (mode == 'title' and target in page.title()):
                        self.page = page
                        return
        else:
            handles = self.browser.window_handles
            if mode == 'name' and self.tabs.get(target) in handles:
                self.browser.switch_to.window(self.tabs[target]); return
            if mode == 'index' and 0 < index <= len(handles):
                self.browser.switch_to.window(handles[index-1]); return
            for handle in handles:
                self.browser.switch_to.window(handle)
                if (mode == 'url' and target in self.url()) or (mode == 'title' and target in self.browser.title):
                    return
        raise RuntimeError('Target tab not found: ' + str(target))

    @staticmethod
    def _prioritize_semantic_rules(rules, match):
        """Choose dropdown options by *role and exact name*, never by position.

        Recorded selectors often include broad role CSS plus exact text. Their
        separate matches can include multiple options and nested labels. A
        combined role/name locator uses both facts from the original recording.
        """
        if match != 'unique':
            return list(rules)
        named_roles = [rule for rule in rules
                       if rule.get('strategy') == 'role' and rule.get('exact') is True
                       and str(rule.get('value') or '').strip()]
        if named_roles:
            # An explicitly named option must not degrade into a generic
            # selector that could choose another menu option.
            if any(str(rule.get('role')).lower() == 'option' for rule in named_roles):
                return named_roles
            return named_roles + [rule for rule in rules if rule not in named_roles]
        option_css = any(
            rule.get('strategy') in ('css', 'component') and re.search(
                r"\[\s*role\s*=\s*['\"]?option['\"]?\s*\]",
                str(rule.get('value') or ''), re.IGNORECASE)
            for rule in rules)
        exact_texts = {str(rule.get('value')).strip() for rule in rules
                       if rule.get('strategy') == 'text'
                       and rule.get('exact') is True and str(rule.get('value') or '').strip()}
        if option_css and len(exact_texts) == 1:
            # No fallback to broad CSS or a duplicate label: missing named
            # options must not cause selection of a different option.
            return [{'strategy': 'role', 'role': 'option',
                     'value': next(iter(exact_texts)), 'exact': True}]
        return list(rules)

    def locate(self, rules, match='first', nth=1, timeout=10000, frame=None, auto_frame=False):
        if not rules:
            raise RuntimeError('Selector is required')
        if self.backend == 'selenium':
            rules = self._prioritize_semantic_rules(rules, match)
        failures = []
        for index, rule in enumerate(rules, 1):
            try:
                item = self._find(rule, match, nth, timeout, frame, auto_frame)
                if item is not None:
                    return item
            except Exception as err:
                # Report the actual rejected rule rather than ChromeDriver's
                # enormous address-only stacktrace. Never silently click another
                # element when an invalid selector cannot be safely translated.
                detail = str(err).split('Stacktrace:')[0].strip().replace('\n', ' ')
                label = str(rule.get('strategy', 'css')) + ':' + str(rule.get('value', ''))[:140]
                failures.append(f'#{index} {label} => {detail[:320]}')
        raise RuntimeError('No matching selector: ' + ' | '.join(failures))

    def _find(self, r, match, nth, timeout, frame=None, auto_frame=False):
        strategy = r.get('strategy', 'css')
        val = str(r.get('value', ''))
        if self.backend == 'playwright':
            scope = self.resolve_frame(frame, auto_frame, r)
            if strategy == 'role': q = scope.get_by_role(r.get('role', 'button'), name=val, exact=r.get('exact', False))
            elif strategy == 'label': q = scope.get_by_label(val, exact=r.get('exact', False))
            elif strategy == 'placeholder': q = scope.get_by_placeholder(val, exact=r.get('exact', False))
            elif strategy == 'text': q = scope.get_by_text(val, exact=r.get('exact', False))
            elif strategy == 'name': q = scope.locator('[name="' + val.replace('"', '\\"') + '"]')
            elif strategy == 'testId': q = scope.get_by_test_id(val)
            elif strategy == 'xpath': q = scope.locator('xpath=' + val)
            elif strategy in ('css','component'): q = scope.locator(val)
            else: raise RuntimeError('Unknown selector strategy: ' + strategy)
            # Match the TypeScript resolver: count only visible desktop elements.
            # Responsive sites often contain hidden/mobile duplicates of buttons.
            visible = q.filter(visible=True)
            desktop_indices = visible.evaluate_all(
                "elements => elements.map((el, index) => ({ el, index }))"
                ".filter(({ el }) => !el.closest(" + json.dumps(_NON_DESKTOP_SELECTOR) + "))"
                ".map(({ index }) => index)"
            )
            count = len(desktop_indices)
            if not count:
                raise RuntimeError(f'{strategy}:{val[:160]} - no visible desktop elements (DOM matches: {q.count()})')
            if match == 'unique' and count != 1:
                raise RuntimeError(f'{strategy}:{val[:160]} - Selector is not unique ({count} visible desktop elements)')
            index = int(nth) - 1 if match == 'nth' else count - 1 if match == 'last' else 0
            if index < 0 or index >= count:
                raise RuntimeError(f'{strategy}:{val[:160]} - requested item {nth}, only {count} visible desktop elements')
            item = visible.nth(desktop_indices[index])
            item.wait_for(state='visible', timeout=timeout)
            return item
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.common.exceptions import InvalidSelectorException
        by, value = self._selenium_strategy(r)
        def find(_):
            found = self._selenium_find(by, value, frame, auto_frame)
            if not found: return False
            # Exclude hidden/mobile responsive duplicates, as the TypeScript engine does.
            found = [el for el in found if el.is_displayed() and not self.browser.execute_script(
                "return Boolean(arguments[0].closest(" + json.dumps(_NON_DESKTOP_SELECTOR) + "))", el)]
            count = len(found)
            if not count: return False
            diagnostic = ''
            if match == 'unique' and count > 1:
                found, diagnostic = self._disambiguate_selenium_option(found, r)
                count = len(found)
            if match == 'unique' and count != 1:
                raise RuntimeError(f'{strategy}:{val[:160]} - Selector is not unique ({count} visible desktop elements)'
                                   + ('; active popup inspection: ' + diagnostic if diagnostic else ''))
            pos = count - 1 if match == 'last' else int(nth)-1 if match == 'nth' else 0
            if not 0 <= pos < count:
                raise RuntimeError(f'{strategy}:{val[:160]} - requested item {nth}, only {count} visible desktop elements')
            return found[pos]
        return WebDriverWait(self.browser, timeout / 1000).until(find)

    def resolve_frame(self, frame=None, auto_frame=False, rule=None):
        """A frame rule limits scope; autoFrameSearch tries main page then matching descendants."""
        if self.backend != 'playwright':
            return None
        if frame:
            for scope in self.page.frames:
                if frame.get('name') and scope.name != frame['name']: continue
                if frame.get('urlIncludes') and frame['urlIncludes'] not in scope.url: continue
                if frame.get('selector'):
                    try:
                        frame_element = scope.frame_element()
                        if not frame_element.evaluate('(el,s)=>el.matches(s)', frame['selector']): continue
                    except Exception: continue
                return scope
            raise RuntimeError('Target frame not found: '+repr(frame))
        if auto_frame and rule:
            scopes = [self.page.main_frame] + [f for f in self.page.frames if f != self.page.main_frame]
            for scope in scopes:
                try:
                    value = rule.get('value','')
                    strategy = rule.get('strategy','css')
                    if strategy == 'xpath': locator = scope.locator('xpath='+value)
                    elif strategy == 'text': locator = scope.get_by_text(value)
                    elif strategy == 'role': locator = scope.get_by_role(rule.get('role','button'), name=value)
                    elif strategy == 'label': locator = scope.get_by_label(value)
                    elif strategy == 'placeholder': locator = scope.get_by_placeholder(value)
                    elif strategy == 'testId': locator = scope.get_by_test_id(value)
                    elif strategy == 'name': locator = scope.locator('[name='+json.dumps(value)+']')
                    else: locator = scope.locator(value)
                    if locator.filter(visible=True).count(): return scope
                except Exception: continue
        return self.page

    def _selenium_frames(self, frame=None, auto_frame=False):
        from selenium.webdriver.common.by import By
        from selenium.common.exceptions import WebDriverException
        self.browser.switch_to.default_content()
        def descend(depth=0):
            if depth > 8: return
            yield None
            for node in self.browser.find_elements(By.CSS_SELECTOR, 'iframe,frame'):
                try:
                    self.browser.switch_to.frame(node)
                    yield from descend(depth+1)
                    self.browser.switch_to.parent_frame()
                except WebDriverException:
                    try: self.browser.switch_to.parent_frame()
                    except Exception: self.browser.switch_to.default_content()
        # Selenium searches must leave driver in the discovered frame when an element is found.
        def matches():
            if not frame: return True
            if frame.get('name') and self.browser.execute_script('return window.name') != frame['name']: return False
            if frame.get('urlIncludes') and frame['urlIncludes'] not in self.browser.execute_script('return location.href'): return False
            return True
        if frame or auto_frame:
            yield matches
        else:
            yield lambda: True

    @staticmethod
    def _is_extended_css(selector):
        return bool(_PLAYWRIGHT_CSS_EXTENSIONS.search(selector))

    @staticmethod
    def _selenium_strategy(rule):
        """Resolve locator() shorthand before invoking the strict WebDriver CSS API.

        Playwright accepts //, .., xpath= and text= inside locator() even if an
        exported rule was saved as strategy='css'. WebDriver does not. Preserve
        semantics and uniqueness checks by routing to the corresponding engine.
        """
        strategy = str(rule.get('strategy') or 'css')
        value = str(rule.get('value') or '').strip()
        if not value:
            raise ValueError('Empty selector')
        if strategy in ('css', 'component'):
            if value.startswith('xpath='):
                return 'xpath', value[len('xpath='):]
            # Playwright auto-detects XPath expressions starting with // or ..
            if value.startswith(('//', './/', '../', '..[', '(//', '(.//', '(/')) or value == '..':
                return 'xpath', value
            if value.startswith('css='):
                value = value[len('css='):].strip()
                if not value:
                    raise ValueError('Empty css= selector')
            if value.startswith('text='):
                text = value[len('text='):].strip()
                exact = len(text) >= 2 and text[0] in ('\"', "'") and text[-1] == text[0]
                if exact:
                    text = text[1:-1]
                return 'as-locator-rule', {'strategy': 'text', 'value': text, 'exact': exact}
            return ('as-playwright-css', value) if _PLAYWRIGHT_CSS_EXTENSIONS.search(value) else ('css selector', value)
        if strategy == 'xpath':
            return 'xpath', value[len('xpath='):] if value.startswith('xpath=') else value
        if strategy in ('name', 'testId', 'placeholder', 'text', 'label', 'role'):
            return 'as-locator-rule', dict(rule, value=value)
        raise RuntimeError('Unknown selector strategy: ' + strategy)

    def selenium_css_helper(self):
        """Browser-side selector compatibility; shipped with every Python ZIP."""
        if self._css_helper is None:
            helper_path = Path(__file__).with_name('selector_compat.js')
            self._css_helper = helper_path.read_text(encoding='utf-8')
        return self._css_helper

    def selenium_locator_helper(self):
        if self._locator_helper is None:
            helper_path = Path(__file__).with_name('locator_compat.js')
            self._locator_helper = helper_path.read_text(encoding='utf-8')
        return self._locator_helper

    def selenium_option_helper(self):
        if self._option_helper is None:
            self._option_helper = Path(__file__).with_name('option_compat.js').read_text(encoding='utf-8')
        return self._option_helper

    def _disambiguate_selenium_option(self, elements, rule):
        """Restrict duplicate named options to their active, accessible popup.

        Return the original list if neither ARIA ownership nor hit-testing can
        prove a unique target. Never fall back to first()/last() under unique.
        """
        if (rule.get('strategy') != 'role' or rule.get('role') != 'option'
                or rule.get('exact') is not True or len(elements) < 2):
            return elements, ''
        from selenium.common.exceptions import StaleElementReferenceException
        try:
            report = self.browser.execute_script(
                'return (' + self.selenium_option_helper() + ')(arguments[0], arguments[1])',
                elements, self._active_dropdown_trigger)
        except StaleElementReferenceException:
            self._active_dropdown_trigger = None
            report = self.browser.execute_script(
                'return (' + self.selenium_option_helper() + ')(arguments[0], null)', elements)
        return report['elements'], str(report.get('reason', '')) + ' ' + str(report.get('detail', []))[:430]

    def _selenium_query(self, by, value):
        if by == 'as-playwright-css':
            return self.browser.execute_script('return (' + self.selenium_css_helper() + ')(document, arguments[0])', value)
        if by == 'as-locator-rule':
            return self.browser.execute_script(
                'const css=(' + self.selenium_css_helper() + ');'
                'return (' + self.selenium_locator_helper() + ')(document, arguments[0], css)', value)
        try:
            return self.browser.find_elements(by, value)
        except Exception as exc:
            # The original ChromeDriver message alone does not identify which
            # locator failed. Do not change it to :first or a broad text match.
            if 'invalid selector' in str(exc).lower() or type(exc).__name__ == 'InvalidSelectorException':
                raise ValueError(f'Invalid {by} selector {str(value)[:180]!r}; '
                    'verify XPath/CSS syntax or a Playwright-only pseudo-class') from exc
            raise

    def _selenium_find(self, by, value, frame=None, auto_frame=False):
        from selenium.webdriver.common.by import By
        self.browser.switch_to.default_content()
        if frame and frame.get('selector'):
            frame_selector = frame['selector']
            frame_by, frame_value = self._selenium_strategy({'strategy':'css', 'value':frame_selector})
            candidates = self._selenium_query(frame_by, frame_value)
            if not candidates: return []
            for candidate in candidates:
                try:
                    self.browser.switch_to.default_content()
                    self.browser.switch_to.frame(candidate)
                    if frame.get('name') and self.browser.execute_script('return window.name')!=frame['name']:
                        self.browser.switch_to.default_content()
                        continue
                    if frame.get('urlIncludes') and frame['urlIncludes'] not in self.browser.execute_script('return location.href'):
                        self.browser.switch_to.default_content()
                        continue
                    found=self._selenium_query(by,value)
                    if found:return found
                except Exception:continue
            return []
        def search(depth):
            if frame is None or frame_matches():
                items = self._selenium_query(by, value)
                if items:
                    # Hidden main-document duplicates must not block a visible
                    # matching element inside an iframe.
                    if not auto_frame or any(item.is_displayed() for item in items):
                        return items
            if depth >= 8: return []
            for idx in range(len(self.browser.find_elements(By.CSS_SELECTOR, 'iframe,frame'))):
                try:
                    frames = self.browser.find_elements(By.CSS_SELECTOR, 'iframe,frame')
                    self.browser.switch_to.frame(frames[idx]); found = search(depth+1)
                    if found: return found
                    self.browser.switch_to.parent_frame()
                except Exception:
                    try: self.browser.switch_to.parent_frame()
                    except Exception: self.browser.switch_to.default_content()
            return []
        def frame_matches():
            if frame.get('name') and self.browser.execute_script('return window.name') != frame['name']: return False
            if frame.get('urlIncludes') and frame['urlIncludes'] not in self.browser.execute_script('return location.href'): return False
            return True
        if frame or auto_frame:
            return search(0)
        return self._selenium_query(by, value)

    def selector_state(self, rules, frame=None, auto_frame=False):
        """Return (attached, visible); unlike locate(), hidden items count as attached.
        Used by wait/verification so duplicate visible matches cannot be mistaken
        for a hidden or missing element.
        """
        attached = visible = False
        for rule in rules or []:
            strategy, value = rule.get('strategy', 'css'), rule.get('value','')
            if self.backend == 'selenium':
                from selenium.webdriver.common.by import By
                by, expr = self._selenium_strategy(rule)
                items = self._selenium_find(by, expr, frame, False)
                if auto_frame and not frame:
                    # Include hidden main-frame nodes as attached; search frames
                    # separately for visible matches.
                    other = self._selenium_find(by, expr, frame, True)
                    items = list(dict.fromkeys(items + other))
                attached = attached or bool(items)
                visible = visible or any(item.is_displayed() for item in items)
            else:
                scopes = [self.resolve_frame(frame)] if frame else self.page.frames if auto_frame else [self.page]
                for scope in scopes:
                    if strategy == 'xpath': query = scope.locator('xpath=' + value)
                    elif strategy in ('css','component'): query = scope.locator(value)
                    elif strategy == 'role': query = scope.get_by_role(rule.get('role','button'),name=value,exact=rule.get('exact',False))
                    elif strategy == 'label': query = scope.get_by_label(value,exact=rule.get('exact',False))
                    elif strategy == 'text': query = scope.get_by_text(value,exact=rule.get('exact',False))
                    elif strategy == 'placeholder': query = scope.get_by_placeholder(value,exact=rule.get('exact',False))
                    elif strategy == 'testId': query = scope.get_by_test_id(value)
                    elif strategy == 'name': query = scope.locator('[name=' + json.dumps(value) + ']')
                    else: raise ValueError('Unsupported rule: ' + strategy)
                    matches = query.count()
                    attached = attached or bool(matches)
                    if matches:
                        visible = visible or query.filter(visible=True).count() > 0
        return attached, visible

    def reload(self, timeout_ms=15000):
        if self.backend == 'playwright': self.page.reload(wait_until='domcontentloaded', timeout=timeout_ms)
        else: self.browser.refresh()

    def evaluate(self, code, value=None):
        """Execute original workflow scripts inside the browser, NOT Python/Node filesystem."""
        if self.backend == 'playwright':
            return self.page.evaluate('([source,argument]) => (0,eval)(source)', [code, value])
        return self._evaluate_selenium(code)

    def _evaluate_selenium(self, code):
        result = self.browser.execute_async_script("""const source=arguments[0],done=arguments[arguments.length-1];
Promise.resolve().then(()=> (0,eval)(source)).then(v=>done({ok:true,value:v===undefined?null:v}),e=>done({ok:false,error:String(e)}));""",code)
        if not result.get('ok'): raise RuntimeError('Browser JavaScript failed: '+str(result.get('error')))
        return result.get('value')

    def list_items(self, rules, limit=20, frame=None, auto_frame=False):
        """Structured list snapshot compatible with Automation Studio fingerprint/text JSON."""
        limit = max(1,min(100,int(limit)))
        collected, fingerprints = [], set()
        if self.backend == 'playwright':
            scopes = [self.resolve_frame(frame, False)] if frame else (self.page.frames if auto_frame else [self.page])
            for scope in scopes:
                for rule in rules:
                    if rule.get('strategy') == 'component': continue
                    try:
                        typ,value=rule.get('strategy','css'),rule.get('value','')
                        if typ=='role': loc=scope.get_by_role(rule.get('role','button'),name=value,exact=rule.get('exact',False))
                        elif typ=='label': loc=scope.get_by_label(value)
                        elif typ=='text': loc=scope.get_by_text(value)
                        elif typ=='placeholder': loc=scope.get_by_placeholder(value)
                        elif typ=='name': loc=scope.locator('[name='+json.dumps(value)+']')
                        elif typ=='testId': loc=scope.get_by_test_id(value)
                        elif typ=='xpath': loc=scope.locator('xpath='+value)
                        else: loc=scope.locator(value)
                        for ix in range(min(loc.count(),limit*3)):
                            item=loc.nth(ix)
                            if not item.is_visible(): continue
                            info=item.evaluate(_ITEM_INFO_JS)
                            if not info or not info['text']: continue
                            fingerprint=json.dumps(info,ensure_ascii=False,separators=(',',':'))
                            if fingerprint in fingerprints: continue
                            fingerprints.add(fingerprint)
                            collected.append({'fingerprint':fingerprint,'text':info['text'],'element':item})
                            if len(collected)>=limit: return collected
                    except Exception: continue
        else:
            from selenium.webdriver.common.by import By
            for rule in rules:
                try:
                    selector = rule.get('value','')
                    strategy = rule.get('strategy','css')
                    if strategy == 'component':
                        continue
                    by, selector = self._selenium_strategy(rule)
                    for item in self._selenium_find(by,selector,frame,auto_frame)[:limit*3]:
                        if not item.is_displayed():continue
                        info=self.browser.execute_script('return ('+_ITEM_INFO_JS+')(arguments[0])',item)
                        if not info or not info['text']:continue
                        fingerprint=json.dumps(info,ensure_ascii=False,separators=(',',':'))
                        if fingerprint in fingerprints:continue
                        fingerprints.add(fingerprint)
                        collected.append({'fingerprint':fingerprint,'text':info['text'],'element':item})
                        if len(collected)>=limit:return collected
                except Exception:continue
        return collected

    def clipboard(self, text):
        """Use granted clipboard permissions where supported; fall back to user-visible copy."""
        js="""async (value) => {
          try { if(navigator.clipboard?.writeText) {await navigator.clipboard.writeText(value); return true;} }
          catch (_) {}
          const input=document.createElement('textarea');input.value=value;
          input.style.position='fixed';input.style.opacity='0';document.body.appendChild(input);
          input.focus();input.select();const ok=document.execCommand('copy');input.remove();return ok;
        }"""
        if self.backend == 'playwright':
            try:
                origin=self.page.evaluate('location.origin')
                self.context.grant_permissions(['clipboard-read','clipboard-write'],origin=origin)
            except Exception:pass
            result=self.page.evaluate(js,text)
        else:
            try:
                origin=self.browser.execute_script('return location.origin')
                self.browser.execute_cdp_cmd('Browser.grantPermissions',{'origin':origin,'permissions':['clipboardReadWrite','clipboardSanitizedWrite']})
            except Exception:pass
            result=self.browser.execute_async_script("""const text=arguments[0],done=arguments[arguments.length-1];
(async ()=>{try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return true;}}catch(_){}
const x=document.createElement('textarea');x.value=text;document.body.appendChild(x);x.focus();x.select();
const ok=document.execCommand('copy');x.remove();return ok;})().then(done,()=>done(false));""",text)
        if not result:raise RuntimeError('Browser clipboard permission denied; interact with the visible tab to permit copying')

    def direct_download(self, item, filename=None, timeout=60000, expected_format=None):
        """Authenticated HTTP GET for a link; never sends credentials outside allowlisted hosts."""
        from urllib.parse import urlsplit
        from http.cookiejar import CookieJar
        if self.backend=='playwright':
            href=item.get_attribute('href')
            cookies=self.context.cookies()
        else:
            href=item.get_attribute('href')
            cookies=self.browser.get_cookies()
        if not href: raise RuntimeError('Direct download requires a link href')
        url=urljoin(self.url(),href)
        from urllib.request import build_opener, HTTPCookieProcessor, HTTPRedirectHandler
        allowed=self.project.get('allowedDomains',[])
        def host_ok(address):
            parsed=urlsplit(address); host=(parsed.hostname or '').lower()
            return parsed.scheme in ('https','http') and any(host==d.lower() or (d.startswith('*.') and host.endswith(d[1:].lower())) for d in allowed)
        if not host_ok(url): raise RuntimeError('Direct link outside allowed domains')
        import http.cookiejar
        jar=http.cookiejar.CookieJar()
        for c in cookies:
            jar.set_cookie(http.cookiejar.Cookie(version=0,name=c['name'],value=c['value'],port=None,port_specified=False,domain=c['domain'],domain_specified=True,domain_initial_dot=c['domain'].startswith('.'),path=c.get('path','/'),path_specified=True,secure=c.get('secure',False),expires=None,discard=True,comment=None,comment_url=None,rest={},rfc2109=False))
        class VerifiedRedirect(HTTPRedirectHandler):
            def redirect_request(self,req,fp,code,msg,headers,newurl):
                if not host_ok(newurl): raise RuntimeError('Redirect outside allowed domains')
                return super().redirect_request(req,fp,code,msg,headers,newurl)
        opener=build_opener(HTTPCookieProcessor(jar),VerifiedRedirect())
        with opener.open(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=max(1,timeout/1000)) as response:
            if not host_ok(response.url):raise RuntimeError('Download final URL is outside allowed domains')
            data=response.read(200*1024*1024+1)
            if len(data)>200*1024*1024: raise RuntimeError('Download too large')
            if not data: raise RuntimeError('Empty direct download')
            disposition = response.headers.get('Content-Disposition', '')
            source_name = _content_disposition_filename(disposition) or unquote(Path(urlsplit(response.url).path).name)
            content_type = response.headers.get('Content-Type', '')
            name = _download_name(filename, source_name, content_type, data)
            _validate_download_blob(data, name, expected_format)
            target = _available_download_path(self.download_dir, name)
            target.write_bytes(data)
            return str(target)

    def component_action(self, step, value):
        path=step.get('componentPath') or next((r.get('value') for r in step.get('selectors',[]) if r.get('strategy')=='component'),None)
        if not path:raise RuntimeError('Missing componentPath')
        js="""(arg) => {
          const component=arg.path.split('.').reduce((o,k)=>o?.[k],window) || window.Ext?.getCmp?.(arg.path);
          if(!component)throw Error('Component not found: '+arg.path);
          if(arg.kind==='fill'||arg.kind==='select')component.setValue?.(arg.value);
          else if(arg.kind==='check')component.setValue?.(arg.adapter==='ksi'?(arg.value||true):true);
          else if(arg.kind==='uncheck')component.setValue?.(false);
          else if(arg.kind==='click')component.fireEvent?.('click',component);
          component.fireEvent?.('change',component,component.getValue?.());
          component.fireEvent?.('select',component,component.getStore?.()?.findRecord?.('value',arg.value));
          return true;
        }"""
        args={'path':path,'kind':step['kind'],'value':value,'adapter':step.get('adapter')}
        if self.backend=='playwright':
            scope=self.resolve_frame(step.get('frame'))
            scope.evaluate(js,args)
        else:
            self._selenium_find('css selector','html',step.get('frame'),step.get('autoFrameSearch',False))
            self.browser.execute_script('return ('+js+')(arguments[0])',args)

    def _selenium_safe_click(self, item):
        """Perform a real WebDriver click with bounded, non-forcing scroll recovery.

        Fixed/sticky navbars can intercept a button when Selenium scrolls it to
        the top of the viewport. Center the target before clicking, and retry
        ONLY a confirmed interception. Never use JS element.click() or click a
        different element: downloads and form submissions must remain safe.
        """
        from selenium.common.exceptions import ElementClickInterceptedException

        last_interception = None
        for attempt in range(3):
            # scrollIntoView centers inside scrollable ancestors, unlike the
            # default WebDriver scroll behavior (which can place a target under
            # a fixed header). On retry, also scroll upward slightly to move
            # the target down and away from a top sticky navigation overlay.
            try:
                info = self.browser.execute_script(r"""
                  const el = arguments[0], retry = arguments[1];
                  if (!el.isConnected) return {state:'detached'};
                  el.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
                  if (retry) {
                    const delta = Math.min(140, Math.max(50, innerHeight * 0.15));
                    let parent = el.parentElement, scrolled = false;
                    while (parent && parent !== document.documentElement) {
                      const style = getComputedStyle(parent);
                      if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
                        const before = parent.scrollTop;
                        parent.scrollTop = Math.max(0, before - delta);
                        scrolled = parent.scrollTop !== before;
                        break;
                      }
                      parent = parent.parentElement;
                    }
                    if (!scrolled) window.scrollBy(0, -delta);
                  }
                  const r = el.getBoundingClientRect();
                  const x = Math.max(0, Math.min(innerWidth-1, r.left+r.width/2));
                  const y = Math.max(0, Math.min(innerHeight-1, r.top+r.height/2));
                  const top = document.elementFromPoint(x,y);
                  return {state:'ready',x:Math.round(x),y:Math.round(y),
                    blocked:!!top && top !== el && !el.contains(top),
                    covering:top && top !== el && !el.contains(top)
                      ? String(top.tagName||'').toLowerCase()+' '+String(top.getAttribute('href')||top.getAttribute('role')||'').slice(0,100)
                      : ''};
                """, item, attempt > 0)
                if isinstance(info, dict) and info.get('state') == 'detached':
                    raise RuntimeError('Click target detached before interaction; do not replay a submission blindly')
            except RuntimeError:
                raise
            except Exception:
                # Let WebDriver report unsupported/failing scrolling itself.
                info = None
            try:
                item.click()
                return
            except ElementClickInterceptedException as error:
                last_interception = error
                if attempt == 2:
                    cover = info.get('covering') if isinstance(info, dict) else ''
                    raise RuntimeError('Click remains obstructed after centered scrolling'
                        + ((' by ' + cover) if cover else '')
                        + '; check fixed navigation, modal or overlay before replaying') from error
                time.sleep(.25)
        if last_interception:
            raise last_interception

    def act(self, action, item, value=''):
        if self.backend == 'playwright':
            if action == 'click': item.click()
            elif action == 'dblclick': item.dblclick()
            elif action == 'fill': item.fill(str(value))
            elif action == 'press': item.press(str(value))
            elif action == 'hover': item.hover()
            elif action == 'check': item.check()
            elif action == 'uncheck': item.uncheck()
            elif action == 'select':
                try: item.select_option(str(value))
                except Exception: item.select_option(label=str(value))
            elif action == 'upload': item.set_input_files(str(value))
        else:
            from selenium.webdriver.common.action_chains import ActionChains
            from selenium.webdriver.support.ui import Select
            if action == 'click':
                # Save the clicked combobox, so the next option step can use
                # its aria-controls rather than any other identical option.
                try:
                    is_trigger = self.browser.execute_script('''return Boolean(arguments[0].matches(
                        '[role="combobox"],[aria-haspopup="listbox"],[aria-controls][aria-expanded]'))''', item)
                except Exception:
                    is_trigger = False
                self._selenium_safe_click(item)
                if is_trigger:
                    self._active_dropdown_trigger = item
                else:
                    try:
                        if item.get_attribute('role') == 'option':
                            self._active_dropdown_trigger = None
                    except Exception:
                        pass
            elif action == 'dblclick': ActionChains(self.browser).double_click(item).perform()
            elif action == 'fill': item.clear(); item.send_keys(str(value))
            elif action == 'press':
                from selenium.webdriver.common.keys import Keys
                parts=str(value).split('+')
                aliases={'CONTROL':'CONTROL','CTRL':'CONTROL','CMD':'META','COMMAND':'META',
                         'ALT':'ALT','SHIFT':'SHIFT','ENTER':'ENTER','RETURN':'ENTER','ESC':'ESCAPE',
                         'ESCAPE':'ESCAPE','TAB':'TAB','BACKSPACE':'BACKSPACE','DELETE':'DELETE',
                         'ARROWDOWN':'ARROW_DOWN','ARROWUP':'ARROW_UP','ARROWLEFT':'ARROW_LEFT','ARROWRIGHT':'ARROW_RIGHT',
                         'SPACE':'SPACE'}
                values=[getattr(Keys,aliases.get(part.upper(),''),part) for part in parts]
                item.send_keys(''.join(values))
            elif action == 'hover': ActionChains(self.browser).move_to_element(item).perform()
            elif action == 'check' and not item.is_selected(): self._selenium_safe_click(item)
            elif action == 'uncheck' and item.is_selected(): self._selenium_safe_click(item)
            elif action == 'select':
                select = Select(item)
                try: select.select_by_value(str(value))
                except Exception: select.select_by_visible_text(str(value))
            elif action == 'upload': item.send_keys(str(value))

    def visible(self, item):
        return item.is_visible() if self.backend == 'playwright' else item.is_displayed()

    def text(self, item):
        return item.inner_text() if self.backend == 'playwright' else item.text

    def attr(self, item, name):
        return item.get_attribute(name)

    def html(self, item):
        return item.inner_html() if self.backend == 'playwright' else item.get_attribute('innerHTML')

    def screenshot(self, dest):
        if self.backend == 'playwright': self.page.screenshot(path=str(dest), full_page=True)
        else:
            try:
                data=self.browser.execute_cdp_cmd('Page.captureScreenshot',{'format':'png','captureBeyondViewport':True,'fromSurface':True})
                Path(dest).write_bytes(base64.b64decode(data['data']))
            except Exception:self.browser.save_screenshot(str(dest))

    def pdf(self, dest, settings):
        def mm(field):
            value = settings.get(field, 10)
            try: return min(50, max(0, float(value)))
            except (TypeError, ValueError): return 10
        margins = {name: mm('pdfMargin' + name.capitalize() + 'Mm') for name in ('top','right','bottom','left')}
        try: scale = min(2, max(0.1, float(settings.get('pdfScale') or 1)))
        except (TypeError, ValueError): scale = 1.0
        viewport = settings.get('pdfFullPage') is False
        css = None
        if viewport:
            css = '@media print {html,body{max-height:100vh!important;overflow:hidden!important;}}'
        if self.backend == 'playwright':
            style = self.page.add_style_tag(content=css) if css else None
            try:
                self.page.pdf(
                    path=str(dest), format=settings.get('pdfPageSize', 'A4'),
                    landscape=settings.get('pdfOrientation') == 'landscape',
                    print_background=settings.get('pdfPrintBackground') is True,
                    display_header_footer=settings.get('pdfDisplayHeaderFooter') is True,
                    header_template=settings.get('pdfHeaderTemplate') or '',
                    footer_template=settings.get('pdfFooterTemplate') or '',
                    margin={name: str(value) + 'mm' for name,value in margins.items()},
                    scale=scale
                )
            finally:
                if style: style.evaluate('(el) => el.remove()')
        else:
            if css:
                self.browser.execute_script('var el=document.createElement("style"); el.id="as-print-style";el.textContent=arguments[0];document.head.appendChild(el);', css)
            try:
                params = {
                    'printBackground': settings.get('pdfPrintBackground') is True,
                    'landscape': settings.get('pdfOrientation') == 'landscape',
                    'preferCSSPageSize': False,
                    'paperWidth': 8.5 if settings.get('pdfPageSize') == 'Letter' else 8.2677,
                    'paperHeight': 11 if settings.get('pdfPageSize') == 'Letter' else 11.6929,
                    'displayHeaderFooter': settings.get('pdfDisplayHeaderFooter') is True,
                    'headerTemplate': settings.get('pdfHeaderTemplate') or '',
                    'footerTemplate': settings.get('pdfFooterTemplate') or '',
                    'scale': scale,
                    **{'margin' + name.capitalize():value/25.4 for name,value in margins.items()}
                }
                data = self.browser.execute_cdp_cmd('Page.printToPDF', params)
                Path(dest).write_bytes(base64.b64decode(data['data']))
            finally:
                if css: self.browser.execute_script('document.getElementById("as-print-style")?.remove()')

    def _selenium_download_behavior(self, directory=None):
        """Route Chrome downloads only while an explicit workflow action runs.

        Browser.setDownloadBehavior is browser-wide (including existing CDP
        sessions). Always restore 'default' in a finally block. Older Chrome
        builds use the deprecated Page command as a fallback.
        """
        args = ({'behavior': 'allow', 'downloadPath': str(Path(directory).resolve()), 'eventsEnabled': True}
                if directory is not None else {'behavior': 'default'})
        try:
            self.browser.execute_cdp_cmd('Browser.setDownloadBehavior', args)
        except Exception as original:
            fallback = dict(args)
            fallback.pop('eventsEnabled', None)
            try:
                self.browser.execute_cdp_cmd('Page.setDownloadBehavior', fallback)
            except Exception as error:
                raise RuntimeError('Cannot configure or restore Chrome download routing: '
                                   + str(error)) from original

    def _selenium_capture_download(self, item, filename, timeout, expected_format=None):
        """Stage, validate, then promote a browser-triggered download.

        Selenium does not expose a reliable per-click Download object. A fresh
        directory isolates the action; validation excludes browser background
        CRX payloads and HTML masquerading as an expected Excel/PDF file.
        Do NOT claim a stronger causal guarantee than this bounded capture.
        """
        stage = self._download_staging_root / ('capture-' + uuid.uuid4().hex)
        stage.mkdir(parents=True, exist_ok=False)
        observations = {}
        rejected = set()
        result = None
        primary_error = None
        try:
            self._selenium_download_behavior(stage)
            self._selenium_safe_click(item)
            deadline = time.monotonic() + timeout / 1000
            while time.monotonic() < deadline:
                partials = [p for p in stage.iterdir() if p.is_file() and _is_partial_download(p)]
                candidates = sorted((p for p in stage.iterdir() if p.is_file() and not _is_partial_download(p)),
                                    key=lambda p: p.stat().st_mtime)
                for path in candidates:
                    if path in rejected:
                        continue
                    try:
                        info = (path.stat().st_size, path.stat().st_mtime_ns)
                    except FileNotFoundError:
                        continue
                    if info[0] <= 0:
                        continue
                    previous = observations.get(path)
                    observations[path] = info
                    if previous != info or partials:
                        continue  # File must have finished growing between polls.
                    name = _download_name(filename, path.name, file_path=path)
                    try:
                        _validate_download_artifact(path, name, expected_format)
                    except ValueError as error:
                        rejected.add(path)
                        print('[DOWNLOAD-QUARANTINE]', path.name, '-', error)
                        continue
                    target = _available_download_path(self.download_dir, name)
                    path.replace(target)
                    result = str(target)
                    print('[DOWNLOAD-VERIFIED]', path.name, '=>', target.name)
                    return result
                time.sleep(.25)
            residual = [p.name for p in stage.iterdir() if p.is_file()]
            raise TimeoutError('No valid workflow download completed within the timeout. '
                               + 'Quarantined/still downloading: ' + str(residual[:12])
                               + '. Diagnostic staging directory: ' + str(stage))
        except BaseException as error:
            primary_error = error
            raise
        finally:
            try:
                self._selenium_download_behavior(None)
            except Exception as error:
                if primary_error is not None:
                    print('[DOWNLOAD-WARN] Failed to restore Chrome download routing:', error)
                else:
                    raise
            # Unexpected downloads are preserved OUTSIDE downloads/ for inspection,
            # not silently deleted or renamed to a report.
            if stage.exists():
                if not any(stage.iterdir()):
                    stage.rmdir()
                else:
                    print('[DOWNLOAD-DIAGNOSTIC] Non-workflow files kept at:', stage)

    def download(self, item, filename=None, timeout=60000, expected_format=None):
        if self.backend == 'selenium':
            return self._selenium_capture_download(item, filename, timeout, expected_format)
        # Playwright's expect_download binds the returned artifact to this
        # action. Validate its payload before moving into the official folder.
        with self.page.expect_download(timeout=timeout) as task:
            item.click()
        dl = task.value
        import tempfile
        self._download_staging_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='pw-download-', dir=str(self._download_staging_root)) as temp:
            probe = Path(temp) / 'download.tmp'
            dl.save_as(str(probe))
            name = _download_name(filename, dl.suggested_filename, file_path=probe)
            _validate_download_artifact(probe, name, expected_format)
            target = _available_download_path(self.download_dir, name)
            probe.replace(target)
            return str(target)


def _safe_name(value):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip(' .')[:180] or 'download'


# File type resolution is shared by Selenium, Playwright and direct HTTP downloads.
# Never assume every ZIP file is an XLSX; Office files are ZIP containers.
_DOWNLOAD_EXTENSIONS = {
    '.xlsx', '.xlsm', '.xlsb', '.xls', '.csv', '.tsv', '.ods',
    '.docx', '.doc', '.odt', '.rtf', '.pptx', '.ppt', '.odp',
    '.pdf', '.json', '.xml', '.txt', '.html', '.htm', '.zip', '.7z',
    '.tar', '.gz', '.rar', '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.svg', '.tif', '.tiff', '.mp3', '.mp4', '.webm', '.parquet'
}
_MIME_EXTENSIONS = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.oasis.opendocument.spreadsheet': '.ods',
    'application/vnd.oasis.opendocument.text': '.odt',
    'application/vnd.oasis.opendocument.presentation': '.odp',
    'text/csv': '.csv',
    'text/tab-separated-values': '.tsv',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'application/ld+json': '.json',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'text/plain': '.txt',
    'text/html': '.html',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/tiff': '.tif',
    'application/x-7z-compressed': '.7z',
    'application/x-rar-compressed': '.rar',
    'application/gzip': '.gz',
}


def _content_disposition_filename(value):
    if not value:
        return ''
    message = Message()
    message['Content-Disposition'] = value
    try:
        return str(message.get_filename() or '')
    except (ValueError, TypeError, LookupError):
        return ''


def _download_extension(name):
    """Return only a genuine-looking source file extension (not an endpoint)."""
    safe = _safe_name(unquote(str(name or '')))
    lower = safe.lower()
    if lower.endswith('.tar.gz'):
        return '.tar.gz'
    suffix = Path(lower).suffix
    # Do not turn Download.ashx or report.php into an Excel filename suffix.
    return suffix if suffix in _DOWNLOAD_EXTENSIONS else ''


def _custom_has_extension(name):
    # Explicit custom suffixes (including uncommon formats) are user intent.
    # Ignore a trailing dot and protect a lone dot-prefixed basename.
    safe = _safe_name(name)
    suffix = Path(safe).suffix
    return bool(suffix and (suffix.lower() in _DOWNLOAD_EXTENSIONS or re.fullmatch(r'\.[A-Za-z][A-Za-z0-9]{0,11}', suffix)))


def _sniff_extension(blob):
    """Identify a limited set of unambiguous magic signatures.

    For ambiguous text or undocumented binary formats, return empty instead
    of giving users a misleading .xlsx or .pdf extension.
    """
    if not blob:
        return ''
    head = blob[:64]
    if head.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        return '.xls'
    if head.startswith(b'%PDF-'):
        return '.pdf'
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        return '.png'
    if head.startswith(b'\xff\xd8\xff'):
        return '.jpg'
    if head.startswith((b'GIF87a', b'GIF89a')):
        return '.gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        return '.webp'
    if head.startswith(b'7z\xbc\xaf\x27\x1c'):
        return '.7z'
    if head.startswith(b'Rar!\x1a\x07'):
        return '.rar'
    if head.startswith(b'\x1f\x8b'):
        return '.gz'
    if head.startswith(b'PK\x03\x04'):
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                names = set(archive.namelist())
                if 'xl/workbook.xml' in names or 'xl/workbook.bin' in names:
                    return '.xlsx' if 'xl/workbook.xml' in names else '.xlsb'
                if 'word/document.xml' in names:
                    return '.docx'
                if 'ppt/presentation.xml' in names:
                    return '.pptx'
                if 'mimetype' in names:
                    kind = archive.read('mimetype').decode('utf-8', 'replace').strip()
                    return _MIME_EXTENSIONS.get(kind, '.zip')
            return '.zip'
        except (zipfile.BadZipFile, OSError, RuntimeError, KeyError):
            return ''
    return ''


def _sniff_file_extension(path):
    try:
        with open(path, 'rb') as stream:
            head = stream.read(64)
        if head.startswith(b'PK\x03\x04'):
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
                if 'xl/workbook.xml' in names:
                    return '.xlsx'
                if 'xl/workbook.bin' in names:
                    return '.xlsb'
                if 'word/document.xml' in names:
                    return '.docx'
                if 'ppt/presentation.xml' in names:
                    return '.pptx'
                if 'mimetype' in names:
                    kind = archive.read('mimetype').decode('utf-8', 'replace').strip()
                    return _MIME_EXTENSIONS.get(kind, '.zip')
            return '.zip'
        return _sniff_extension(head)
    except (OSError, zipfile.BadZipFile, RuntimeError, KeyError):
        return ''


def _download_name(custom, source='', content_type='', blob=None, file_path=None):
    """Preserve user name and infer extension from trusted download evidence."""
    name = _safe_name(custom if custom else source or 'download')
    if custom and _custom_has_extension(name):
        return _safe_name(name)
    source_ext = _download_extension(source)
    mime = (content_type or '').split(';', 1)[0].strip().lower()
    mime_ext = _MIME_EXTENSIONS.get(mime, '')
    detected = ''
    if not source_ext and not mime_ext:
        if blob is not None:
            detected = _sniff_extension(blob)
        elif file_path is not None:
            try:
                detected = _sniff_file_extension(file_path)
            except OSError:
                pass
    extension = source_ext or mime_ext or detected
    if not custom and source_ext:
        return _safe_name(name)
    # A dynamic web endpoint suffix is not a real file extension.
    if not custom and Path(name).suffix.lower() in ('.ashx', '.aspx', '.php', '.jsp', '.cgi'):
        name = name.rsplit('.', 1)[0]
    if extension:
        base = name[:max(1, 180 - len(extension))].rstrip(' .')
        if base.lower().endswith(extension):
            return _safe_name(base)
        return _safe_name(base + extension)
    print('[DOWNLOAD-WARN] File extension could not be determined; saved without guessing:', name)
    return name


def _is_partial_download(path):
    return path.name.lower().endswith(('.crdownload', '.part', '.partial', '.tmp'))


def _download_format_expected(name, expected_format=None):
    """Use explicit suffixes and the workflow's declared intent only."""
    fmt = str(expected_format or '').strip().lower()
    if fmt in ('excel', 'spreadsheet'):
        return {'.xlsx', '.xls', '.xlsm', '.xlsb', '.csv', '.ods'}
    if fmt in ('pdf', 'json', 'xml', 'csv', 'xlsx', 'xls', 'docx', 'zip'):
        return {'.' + fmt}
    return set()


def _check_download_identity(head, name, actual_type, expected_format=None):
    if head.startswith((b'Cr24', b'Cr26')):
        raise ValueError('Chrome CRX extension/component package, not an expected document')
    claimed = _download_extension(name)
    expected = _download_format_expected(name, expected_format)
    if expected and claimed and claimed not in expected:
        raise ValueError('Downloaded extension ' + claimed + ' conflicts with expected ' + str(sorted(expected)))
    # Strictly check important signature-based formats. A source suggesting
    # XLSX does not make HTML / CRX into an Excel workbook.
    check = claimed if claimed in {'.xlsx', '.xlsm', '.xlsb', '.docx', '.pptx', '.pdf', '.xls', '.zip'} else ''
    if check:
        acceptable = {'.xlsm': {'.xlsx'}, '.xlsb': {'.xlsb'}, '.xlsx': {'.xlsx'},
                      '.docx': {'.docx'}, '.pptx': {'.pptx'}, '.pdf': {'.pdf'},
                      '.xls': {'.xls'}, '.zip': {'.zip', '.xlsx', '.docx', '.pptx', '.xlsb'}}[check]
        if actual_type not in acceptable:
            raise ValueError('File claims ' + check + ' but content signature is '
                             + (actual_type or 'unknown'))
    if expected and actual_type and actual_type not in expected:
        # Valid Office ZIP signatures are more reliable than generic text hints.
        raise ValueError('Content format ' + actual_type + ' does not match expected ' + str(sorted(expected)))
    if expected and head.lstrip()[:32].lower().startswith((b'<!doctype html', b'<html', b'<head', b'<body')):
        raise ValueError('Expected document, but received HTML page')


def _validate_download_artifact(path, name, expected_format=None):
    try:
        if Path(path).stat().st_size <= 0:
            raise ValueError('Empty download')
        with open(path, 'rb') as src:
            head = src.read(4096)
    except OSError as error:
        raise ValueError('Cannot inspect downloaded file: ' + str(error)) from error
    actual = _sniff_file_extension(path)
    _check_download_identity(head, name, actual, expected_format)


def _validate_download_blob(data, name, expected_format=None):
    if not data:
        raise ValueError('Empty download')
    actual = _sniff_extension(data)
    _check_download_identity(data[:4096], name, actual, expected_format)


def _available_download_path(directory, filename):
    """Avoid overwriting previous user downloads with the same name."""
    parent = Path(directory)
    target = parent / _safe_name(filename)
    if not target.exists():
        return target
    suffix = ''.join(target.suffixes[-2:]) if target.name.lower().endswith('.tar.gz') else target.suffix
    stem = target.name[:-len(suffix)] if suffix else target.name
    for index in range(2, 10001):
        candidate = parent / _safe_name(f'{stem[:max(1, 180-len(suffix)-len(str(index))-3)]} ({index}){suffix}')
        if not candidate.exists():
            return candidate
    raise RuntimeError('Download filename collision limit reached')


def _xpath_literal(text):
    if "'" not in text: return "'" + text + "'"
    if '"' not in text: return '"' + text + '"'
    return 'concat(' + ',"\'",'.join("'"+v+"'" for v in text.split("'")) + ')'


def _local_cdp(endpoint):
    target = urlsplit(endpoint)
    if target.scheme not in ('http', 'ws') or target.hostname not in ('localhost', '127.0.0.1', '::1') or target.username or target.password:
        raise ValueError('For security, CDP endpoints must be local only')
    if not target.port:
        raise ValueError('CDP endpoint must specify a port')
    return endpoint

_ITEM_INFO_JS = r"""el => { const h=el; if(h.closest('[class*="mobile" i],[id*="mobile" i],[class*="hamburger" i],[class*="offcanvas" i],[class*="drawer" i]'))return null;
 const a=h.closest('a');const dataset=Object.fromEntries(Object.entries(h.dataset||{}).filter(([k,v])=>v&&/id|key|item|message|conversation|mail/i.test(k)).sort(([a],[b])=>a.localeCompare(b)));
 return {text:String(h.innerText||h.textContent||'').replace(/\s+/g,' ').trim(),id:h.id||'',role:h.getAttribute('role')||'',aria:h.getAttribute('aria-label')||'',title:h.getAttribute('title')||'',href:a?.getAttribute('href')||'',dataset}; }"""
