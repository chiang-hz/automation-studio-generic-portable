# Python CDP export v2.5.6

- Export UI: launch target URL (default), custom allowlisted HTTP(S) URL, or blank page.
- Existing CDP: no navigation by default; explicit opt-in opens a NEW tab without replacing existing work.
- Python Playwright driver: strip conflicting --use-openssl-ca/--use-system-ca flags from inherited NODE_OPTIONS, retaining other options where possible and choosing Windows system CA. No TLS verification disablement.
- Settings stored in `cdp-settings.json` separately from `workflow.json`; no authentication material is exported.
- Re-export Python projects for changes to apply.
