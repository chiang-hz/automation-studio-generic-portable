# Automation Studio v2.4.4 - Chrome auto-detection

1. Run `setup-runtime.bat` as normal. Node.js and its required Node packages are still installed. If system Chrome is detected, all Playwright-managed browser downloads are skipped.
2. Projects with `browser.channel = bundled` use local Google Chrome only if bundled Chromium is not installed. Projects explicitly selecting `chrome` keep their setting. Both headed and headless Chrome are supported.
3. If Chrome is installed at a custom location, set `CHROME_PATH` to the full path of `chrome.exe` before running setup/start.
4. To opt in to downloading the Playwright browser regardless of installed Chrome, run `setup-runtime.bat --install-bundled-browser`.
5. Do not delete existing browser folders automatically: another project may use the bundled browser. After verifying all Automation Studio workflows use system Chrome, you may separately archive/clean up old Playwright runtime browsers.
6. Enterprise Chrome policy can prevent remote debugging or automation. In that case, explicit bundled Chromium remains available as an opt-in. Do not bypass browser access controls.

Playwright `ffmpeg-*` is only needed for features that record video; Automation Studio's current Python/Node browser workflows do not request Playwright video. `winldd-*` is Playwright's Windows diagnostic/support tool, not needed for ordinary operation using system Chrome.
