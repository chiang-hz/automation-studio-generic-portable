"""Regression check for deeply nested condition branches in the hierarchy list."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path(os.environ.get("HIERARCHY_BRANCH_ARTIFACTS", "verification/hierarchy-branch"))
out.mkdir(parents=True, exist_ok=True)


def wait_step(step_id: str, name: str):
    return {
        "id": step_id,
        "name": name,
        "kind": "wait",
        "enabled": True,
        "value": "1",
        "waitAfter": {"kind": "timeout", "timeoutMs": 1},
    }


def condition(step_id: str, name: str, then_steps, else_steps=None):
    return {
        "id": step_id,
        "name": name,
        "kind": "condition",
        "enabled": True,
        "condition": {
            "source": "parameter",
            "name": "hasPdf",
            "operator": "equals",
            "value": "true",
        },
        "thenSteps": then_steps,
        "elseSteps": else_steps or [],
    }


deep_tree = [
    condition(
        "condition-1",
        "檢查明細頁第 1 個 PDF",
        [
            wait_step("download-1", "下載明細頁第 1 個 PDF"),
            condition(
                "condition-2",
                "檢查明細頁第 2 個 PDF",
                [
                    wait_step("download-2", "下載明細頁第 2 個 PDF"),
                    condition(
                        "condition-3",
                        "檢查明細頁第 3 個 PDF",
                        [
                            wait_step("download-3", "下載明細頁第 3 個 PDF"),
                            condition(
                                "condition-4",
                                "檢查明細頁第 4 個 PDF",
                                [wait_step("download-4", "下載明細頁第 4 個 PDF")],
                            ),
                        ],
                    ),
                ],
            ),
        ],
    )
]

with sync_playwright() as p:
    launch_args = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-dev-shm-usage"],
    }
    if os.environ.get("TEST_CHROMIUM"):
        launch_args["executable_path"] = os.environ["TEST_CHROMIUM"]
    browser = p.chromium.launch(**launch_args)
    page = browser.new_page(viewport={"width": 1365, "height": 768})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    project = page.request.post(
        "http://127.0.0.1:4175/api/studio/projects",
        data={
            "id": "hierarchy-branch-regression",
            "name": "階層條件分支版面回歸",
            "targetUrl": "https://example.com",
            "allowedDomains": ["example.com"],
            "adapter": "generic",
            "parameters": [
                {
                    "id": "has-pdf",
                    "name": "hasPdf",
                    "label": "PDF 是否存在",
                    "type": "text",
                    "defaultValue": "true",
                }
            ],
            "steps": deep_tree,
        },
    ).json()["project"]

    page.goto("http://127.0.0.1:4175")
    page.wait_for_load_state("networkidle")
    page.wait_for_function("window.studioBridge && document.documentElement.classList.contains('modern-active')")
    page.evaluate("id => window.studioBridge.loadProject(id)", project["id"])
    page.evaluate("window.studioBridge.navigate('designer')")
    expect(page.locator(".modern-list")).to_be_visible()
    expect(page.locator(".modern-branches")).to_have_count(4)

    geometry = page.evaluate(
        """() => {
          const branches = [...document.querySelectorAll('.modern-branches')].map((el, index) => {
            const r = el.getBoundingClientRect();
            return {
              index,
              width: Math.round(r.width),
              columns: getComputedStyle(el).gridTemplateColumns,
              sectionWidths: [...el.children].map(child => Math.round(child.getBoundingClientRect().width)),
            };
          });
          const steps = [...document.querySelectorAll('.modern-branches .modern-step')].map(el => {
            const r = el.getBoundingClientRect();
            const title = el.querySelector('.step-title')?.getBoundingClientRect();
            return {
              id: el.getAttribute('data-modern-step'),
              width: Math.round(r.width),
              titleWidth: Math.round(title?.width || 0),
            };
          });
          const list = document.querySelector('.modern-list');
          return {
            branches,
            steps,
            bodyWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            listClientWidth: list?.clientWidth || 0,
            listScrollWidth: list?.scrollWidth || 0,
          };
        }"""
    )

    # The top-level condition can remain side-by-side on a wide desktop.
    assert len(geometry["branches"][0]["columns"].split()) == 2, geometry
    # Descendant conditions must stop recursively halving the available width.
    assert all(len(item["columns"].split()) == 1 for item in geometry["branches"][1:]), geometry
    # Nested cards and their labels should remain comfortably readable.
    assert min(step["width"] for step in geometry["steps"]) >= 240, geometry
    assert min(step["titleWidth"] for step in geometry["steps"]) >= 150, geometry
    # No page-level horizontal overflow should be introduced.
    assert geometry["bodyWidth"] <= geometry["viewportWidth"] + 1, geometry
    assert not errors, errors

    page.screenshot(path=str(out / "hierarchy-deep-conditions.png"), full_page=True)
    (out / "geometry.json").write_text(json.dumps(geometry, ensure_ascii=False, indent=2), encoding="utf-8")
    browser.close()

print(json.dumps({"ok": True, "artifacts": str(out)}, ensure_ascii=False))
