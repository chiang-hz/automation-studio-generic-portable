# TypeScript export Node/npm bootstrap V2.5.3

- Check `node.exe --version` and TypeScript syntax support before accepting an installed Node runtime.
- Prefer `npm.cmd` paired with verified Node; check `npm --version`. Reject workflow `node_modules\npm` as an inferred runtime.
- If a working Node lacks npm, recover a full verified Node/npm runtime into the exported project `runtime/node` using official Node v24.13.0 archive pinned SHA256. This downloads the full archive rather than an unverified standalone npm script.
- Subsequent starts reuse verified project-local binaries and cached npm packages, without admin privileges.
- Download retries temporarily relax revocation checks only on revocation errors; full TLS insecure fallback is restricted to the single pinned archive transfer following certificate errors, followed by mandatory SHA256 check. Registry npm TLS fallback only applies to one failed install invocation.
- No global `NODE_TLS_REJECT_UNAUTHORIZED=0` is used.
- Windows `.bat` runtime behavior needs verification in a real Windows host; static and export tests run here.
