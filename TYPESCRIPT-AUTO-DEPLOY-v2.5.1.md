# v2.5.1 TypeScript bootstrap npm path repair

- Explicitly test `npm.cmd --version` before selecting it; `where npm.cmd` alone is insufficient.
- Iterate discovered npm candidates and select the first working one.
- Fall back to a verified project-local `runtime/node` or install a pinned Node.js ZIP containing npm.
- Retain Chrome preference, pinned ZIP SHA256, npm cache, and one-transfer TLS fallback.
- If installing in an existing exported TypeScript project, replace only `start.bat`.
