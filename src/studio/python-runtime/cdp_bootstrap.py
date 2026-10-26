"""One-click Windows CDP bootstrap for standalone Automation Studio Python exports.

Uses only Python standard-library modules. It does not download software, install
packages, alter workflow.json, or copy browser credentials into the export.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from runner import ROOT, hostname_allowed, load_json, main as run_workflow


class CdpStartupError(RuntimeError):
    pass


def endpoint_for(project, chosen_port=None):
    """Only permit an explicit local Chrome DevTools HTTP endpoint."""
    default = (project.get('browser') or {}).get('cdpEndpoint') or 'http://127.0.0.1:9222'
    requested = chosen_port or os.environ.get('AUTOMATION_STUDIO_CDP_PORT')
    if requested is not None:
        try:
            port = int(requested)
        except (ValueError, TypeError) as exc:
            raise CdpStartupError('CDP port must be a number from 1024 to 65535') from exc
        if not 1024 <= port <= 65535:
            raise CdpStartupError('CDP port must be between 1024 and 65535')
        return f'http://127.0.0.1:{port}'
    parsed = urlsplit(default)
    try:
        port = parsed.port
    except ValueError as exc:
        raise CdpStartupError('Invalid CDP endpoint port in workflow settings') from exc
    if (parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1')
            or not port or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path not in ('', '/')):
        raise CdpStartupError('CDP endpoint must use http://127.0.0.1:PORT (local only)')
    return f'http://127.0.0.1:{port}'


def chrome_binary():
    explicit = os.environ.get('CHROME_PATH', '').strip().strip('"')
    if explicit:
        if Path(explicit).is_file():
            return str(Path(explicit).resolve())
        raise CdpStartupError('CHROME_PATH points to a missing file: ' + explicit)
    bases = [os.environ.get(name, '') for name in ('LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)')]
    candidates = [Path(root) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe' for root in bases if root]
    for item in candidates:
        if item.is_file():
            return str(item)
    found = shutil.which('chrome.exe')
    if found:
        return found
    if sys.platform == 'win32':
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe') as key:
                        value = winreg.QueryValue(key, '')
                    if Path(value).is_file():
                        return value
                except OSError:
                    continue
        except ImportError:
            pass
    raise CdpStartupError('Google Chrome not found. Set CHROME_PATH to the installed chrome.exe path.')


def probe(endpoint):
    """Probe without honoring HTTP proxies, even on company-managed computers."""
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(Request(endpoint + '/json/version', headers={'Accept': 'application/json'}), timeout=1.5) as response:
            data = json.loads(response.read(32_768).decode('utf-8'))
        if not isinstance(data, dict) or not data.get('webSocketDebuggerUrl') or not data.get('Browser'):
            return False
        browser_name = str(data.get('Browser', '')).lower()
        return 'chrome' in browser_name or 'chromium' in browser_name or 'headlesschrome' in browser_name
    except (OSError, ValueError, UnicodeError, TimeoutError):
        return False


def tcp_port_open(endpoint):
    import socket
    p = urlsplit(endpoint)
    try:
        with socket.create_connection((p.hostname, p.port), timeout=0.5):
            return True
    except OSError:
        return False


def login_start_url(project):
    """Open only a URL whose exact host the exported workflow permits."""
    url = project.get('targetUrl') or ''
    if urlsplit(url).scheme in ('http', 'https') and hostname_allowed(url, project.get('allowedDomains') or []):
        return url
    return 'about:blank'


def start_chrome(executable, endpoint, project):
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        raise CdpStartupError('LOCALAPPDATA is unavailable; unable to create a persistent Chrome login profile.')
    profile = Path(local) / 'AutomationStudio' / 'ChromeCDPProfile'
    profile.mkdir(parents=True, exist_ok=True)
    port = urlsplit(endpoint).port
    cmd = [executable, '--remote-debugging-address=127.0.0.1', f'--remote-debugging-port={port}',
           '--user-data-dir=' + str(profile), '--no-first-run', '--new-window', login_start_url(project)]
    print('[CDP] Starting installed Chrome (persistent login profile):', str(profile), flush=True)
    try:
        # Chrome continues running after the one-click Python launcher exits.
        kwargs = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
        if sys.platform == 'win32':
            kwargs['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
        return subprocess.Popen(cmd, **kwargs)
    except OSError as exc:
        raise CdpStartupError('Cannot start Chrome: ' + str(exc)) from exc


def wait_for_cdp(endpoint, process=None, seconds=25):
    deadline = time.monotonic() + seconds
    last_notice = -1
    while time.monotonic() < deadline:
        if probe(endpoint):
            print('[CDP] Connected:', endpoint, flush=True)
            return
        if process is not None and process.poll() is not None:
            raise CdpStartupError('Chrome exited before its CDP endpoint became available. Check Chrome policy and profile usage.')
        remaining = max(0, int(deadline - time.monotonic()))
        if remaining // 5 != last_notice:
            print(f'[CDP] Waiting for Chrome DevTools ({remaining}s remaining)...', flush=True)
            last_notice = remaining // 5
        time.sleep(0.5)
    raise CdpStartupError('CDP did not become ready. Close any Chrome already using the dedicated CDP profile, '
                          'check company remote-debugging policy, and rerun. Your login data are not deleted.')


def check_dependencies():
    """Check installed Python packages before opening a browser (no downloads)."""
    from importlib.util import find_spec
    from runner import BACKEND
    module = 'playwright' if BACKEND == 'playwright' else 'selenium'
    if find_spec(module) is None:
        raise CdpStartupError(f'Missing Python package: {module}. Prepare it once using requirements.txt; '
                              'offline PCs can install from an approved local wheelhouse.')


def main(argv=None):
    parser = argparse.ArgumentParser(description='One-click CDP Chrome login and Python workflow runner')
    parser.add_argument('--port', type=int, help='Local CDP port (default: workflow setting or 9222)')
    parser.add_argument('--parameters', help='Optional path to workflow parameters.json')
    parser.add_argument('--check-only', action='store_true', help='Validate workflow without opening Chrome')
    args = parser.parse_args(argv)
    project = load_json(ROOT / 'workflow.json')
    if not isinstance(project, dict) or not project.get('browser'):
        raise CdpStartupError('workflow.json not found or missing browser settings')

    # Run the existing fail-closed validator before any browser is touched.
    override_args = (['--parameters', args.parameters] if args.parameters else [])
    if args.check_only:
        return run_workflow(['--check-only', *override_args])
    if sys.platform != 'win32':
        raise CdpStartupError('run-cdp.bat is intended for Windows with an installed Google Chrome browser.')
    result = run_workflow(['--check-only', *override_args])
    if result:
        return result

    check_dependencies()
    endpoint = endpoint_for(project, args.port)
    if probe(endpoint):
        print('[CDP] Existing local CDP Chrome found. Reusing its current browser session.', flush=True)
        print('[CDP] Confirm this is your intended authorized Chrome window before continuing.', flush=True)
    else:
        if tcp_port_open(endpoint):
            raise CdpStartupError('The configured port is in use but does not serve Chrome DevTools. '
                                  'Close the conflicting application or change AUTOMATION_STUDIO_CDP_PORT.')
        process = start_chrome(chrome_binary(), endpoint, project)
        wait_for_cdp(endpoint, process)

    if not (project.get('browser') or {}).get('authStateEnabled'):
        print('[LOGIN] Workflow has no configured login-success check.', flush=True)
        print('[LOGIN] Sign in to the website in CDP Chrome, then return here.', flush=True)
        try:
            input('[LOGIN] Press Enter after login is complete to start the workflow...')
        except EOFError as exc:
            raise CdpStartupError('Interactive login confirmation requires an open CMD window.') from exc
    else:
        print('[LOGIN] Python checks the configured login-success condition.', flush=True)
        print('[LOGIN] If verification fails, complete the login in Chrome when prompted.', flush=True)

    return run_workflow(['--cdp-endpoint', endpoint, *override_args])


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n[STOP] Interrupted by user', file=sys.stderr)
        sys.exit(130)
    except (CdpStartupError, OSError, ValueError) as exc:
        print('[ERROR]', exc, file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print('[ERROR] Workflow failed:', exc, file=sys.stderr)
        sys.exit(1)
