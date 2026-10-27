# Windows curl 35 / Schannel certificate revocation repair (v2.4.5)

## Root cause

The bundled Node.js bootstrap in `setup-runtime.bat` uses Windows `curl.exe` before Node.js is available. In v2.4.4, only curl exit 60 triggered its existing certificate fallback; Schannel can instead return 35 for `CRYPT_E_NO_REVOCATION_CHECK`.

## Fix

- Prefer fully verified curl download.
- On exit 35, retry this transfer with `--ssl-revoke-best-effort`. If still exit 35, try `--ssl-no-revoke` for this transfer only. Both keep the normal server certificate chain verification enabled; revocation checking is weakened only for the retry.
- On exit 60, preserve legacy per-transfer `--insecure` fallback. This weakens HTTPS authenticity; prefer approved corporate CA/proxy fixes. A hardcoded SHA-256 digest must match before the download is installed or executed.
- Report other curl failures without bypassing TLS. All temporary files continue to use the project's own drive.

## Apply existing installation

1. Close Automation Studio and any setup process.
2. Back up `setup-runtime.bat`.
3. Replace only the root `setup-runtime.bat` with the patch copy.
4. Re-run `setup-runtime.bat` from the project directory. Do not delete `node_modules`, `data`, `runtime\browsers`, or user profiles.

If Node.js already exists, the installer skips this bootstrap. `runtime\node\node.exe` is not included in this patch.
