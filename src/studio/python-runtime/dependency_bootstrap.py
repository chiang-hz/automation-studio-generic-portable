"""Standard-library-only dependency setup for Automation Studio exported Python flows.

Automatically reuses a compatible Python environment or creates a project-local
virtual environment when requirements are missing. Uses wheelhouse before network.
Never modifies workflow.json, browser profiles, credentials or global packages.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
REQUIREMENTS = ROOT / 'requirements.txt'
LOCAL = ROOT / '.local'
VENV = LOCAL / 'python-env'
LOCK = LOCAL / 'dependency-install.lock'
TARGETS = frozenset(('runner.py', 'cdp_bootstrap.py'))

# No third-party imports: this script MUST work before Selenium or Playwright exists.
CHECK_CODE = r'''
import importlib.metadata as md
import importlib.util
import re
import sys
from pathlib import Path

mapping = {'python-docx': 'docx'}
def components(version):
    numbers = re.findall(r'\d+', version.split('+')[0].split('rc')[0])
    return tuple(map(int, numbers))

def satisfies(version, spec):
    found = components(version)
    for operator, target in re.findall(r'(>=|<=|==|!=|>|<|~=)\s*([0-9][\w.]*)', spec):
        expected = components(target)
        left = found + (0,) * max(0, len(expected) - len(found))
        right = expected + (0,) * max(0, len(found) - len(expected))
        if not {'>=':lambda: left >= right, '<=':lambda: left <= right,
                '==':lambda: left == right, '!=':lambda: left != right,
                '>':lambda: left > right, '<':lambda: left < right,
                '~=':lambda: left >= right}[operator]():
            return False
    return True

missing = []
for line in Path(sys.argv[1]).read_text(encoding='utf-8-sig').splitlines():
    line = line.split('#', 1)[0].strip()
    if not line:
        continue
    match = re.fullmatch(r'([A-Za-z0-9_.-]+)\s*(.*)', line)
    if not match:
        missing.append('invalid requirement: ' + line)
        continue
    name, spec = match.groups()
    try:
        version = md.version(name)
        module = mapping.get(name.lower(), name.lower().replace('-', '_'))
        if importlib.util.find_spec(module) is None or not satisfies(version, spec):
            missing.append(name + spec + ' (installed ' + version + ')')
    except (md.PackageNotFoundError, ImportError, ValueError):
        missing.append(name + spec)
if missing:
    print(', '.join(missing))
    sys.exit(2)
'''


def executable(env_dir: Path) -> Path:
    return env_dir / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def missing_dependencies(python: str | Path) -> str:
    result = subprocess.run(
        [str(python), '-c', CHECK_CODE, str(REQUIREMENTS)],
        capture_output=True, text=True, errors='replace', timeout=30,
    )
    if result.returncode == 0:
        return ''
    if result.returncode == 2:
        return result.stdout.strip() or 'requirements.txt'
    raise RuntimeError('Python dependency check failed: ' + (result.stderr or result.stdout).strip())


def acquire_lock():
    LOCAL.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 180
    announced = False
    while True:
        try:
            fd = os.open(str(LOCK), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w', encoding='ascii') as stream:
                stream.write(str(os.getpid()))
            return
        except FileExistsError:
            if not announced:
                print('[SETUP] Another workflow is preparing this Python environment; waiting...', flush=True)
                announced = True
            if time.monotonic() >= deadline:
                raise RuntimeError('Dependency setup is locked for too long. After all installers exit, '
                                   f'check the stale lock at {LOCK}')
            time.sleep(1)


def install(python: Path):
    if os.environ.get('AUTOMATION_STUDIO_AUTO_INSTALL', '1').strip().lower() in ('0', 'false', 'no'):
        raise RuntimeError('Automatic dependency installation is disabled. Install requirements.txt manually.')
    wheelhouse = ROOT / 'wheelhouse'
    offline_only = os.environ.get('AUTOMATION_STUDIO_OFFLINE_ONLY', '').strip().lower() in ('1', 'true', 'yes')
    base = [str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--retries', '2', '--timeout', '20']
    env = dict(os.environ, PIP_DISABLE_PIP_VERSION_CHECK='1')
    if wheelhouse.is_dir():
        print('[SETUP] Trying local wheelhouse first (no network)...', flush=True)
        command = base + ['--no-index', '--find-links', str(wheelhouse), '-r', str(REQUIREMENTS)]
        if subprocess.run(command, cwd=ROOT, env=env).returncode == 0:
            return
        if offline_only:
            raise RuntimeError('Local wheelhouse does not contain all required packages. '
                               'Obtain compatible wheels for your Python version and Windows architecture.')
        print('[SETUP] Local wheelhouse incomplete; trying configured Python package index...', flush=True)
    elif offline_only:
        raise RuntimeError('Offline-only mode enabled, but wheelhouse is missing. '
                           'Place approved dependency wheels in the wheelhouse folder.')

    # pip uses normal certificate verification and existing corporate proxy/index settings.
    command = base + (['--find-links', str(wheelhouse)] if wheelhouse.is_dir() else []) + ['-r', str(REQUIREMENTS)]
    print('[SETUP] Downloading and installing missing Python packages over verified HTTPS...', flush=True)
    if subprocess.run(command, cwd=ROOT, env=env).returncode:
        raise RuntimeError('Package installation failed. Check Internet/proxy/company CA settings, '
                           'or supply an offline wheelhouse. TLS verification was not disabled.')


def prepare_python() -> str:
    if not REQUIREMENTS.is_file():
        raise RuntimeError('requirements.txt was not found in exported Python project.')
    local_python = executable(VENV)
    if local_python.exists():
        missing = missing_dependencies(local_python)
        if not missing:
            print('[SETUP] Using existing project Python environment.', flush=True)
            return str(local_python)
    else:
        missing = missing_dependencies(sys.executable)
        if not missing:
            print('[SETUP] Existing Python dependencies are ready; no download required.', flush=True)
            return sys.executable

    print('[SETUP] Missing or incompatible dependencies: ' + missing, flush=True)
    acquire_lock()
    try:
        # Another process may have completed setup while this process waited.
        if local_python.exists() and not missing_dependencies(local_python):
            return str(local_python)
        if not local_python.exists():
            print('[SETUP] Creating isolated environment in .local/python-env (no administrator privileges)...', flush=True)
            result = subprocess.run([sys.executable, '-m', 'venv', str(VENV)], cwd=ROOT)
            if result.returncode or not local_python.exists():
                raise RuntimeError('Could not create a Python virtual environment. '
                                   'Check Python venv/ensurepip support and write permissions.')
        install(local_python)
        remaining = missing_dependencies(local_python)
        if remaining:
            raise RuntimeError('Packages are still unavailable after installation: ' + remaining)
        print('[SETUP] All required packages installed. Starting workflow.', flush=True)
        return str(local_python)
    finally:
        try:
            LOCK.unlink()
        except FileNotFoundError:
            pass


def main(args: list[str]):
    if not args or Path(args[0]).name not in TARGETS or args[0] not in TARGETS:
        raise RuntimeError('Specify runner.py or cdp_bootstrap.py as the entrypoint.')
    target = ROOT / args[0]
    if not target.is_file():
        raise RuntimeError(f'Exported entrypoint missing: {target.name}')
    # --check-only is a structural validation and needs no browser packages.
    # Intentionally avoid touching the network when only validation is requested.
    python = sys.executable if '--check-only' in args[1:] else prepare_python()
    return subprocess.call([str(python), str(target), *args[1:]], cwd=ROOT)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print('\n[ERROR] Setup cancelled by user.', file=sys.stderr)
        sys.exit(130)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print('[ERROR] ' + str(exc), file=sys.stderr)
        sys.exit(1)
