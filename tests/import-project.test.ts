import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "studio-import-regression-"));
process.env.STUDIO_DATA_DIR = temporary;
const { createDefaultProject, createImportedProject, StudioStore } = await import("../src/studio/store.ts");
const { createStudioRouter } = await import("../src/studio/router.ts");
after(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

const legacyId = "workflow-mtwdl63i-import-mu3ikz1c-import-mu3o24u3-import-mu544t5n-import-muw8va9k-import-muxmk8ad-import-muxuvy4l";

test("repeated imports get independent bounded IDs while retaining workflow contents", () => {
  let input = createDefaultProject({ id: legacyId, name: "opendata", version: "1.0.18" });
  const ids = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const imported = createImportedProject(input);
    assert.match(imported.id, /^workflow-import-[0-9a-f-]{36}$/);
    assert.equal(imported.id.length, 52);
    assert.ok(!ids.has(imported.id));
    assert.deepEqual(imported.steps, input.steps);
    assert.deepEqual(imported.parameters, input.parameters);
    assert.equal(imported.version, "1.0.18");
    ids.add(imported.id);
    input = imported;
  }
});

test("identifier validation distinguishes length, characters, and empty values", async () => {
  assert.equal(createDefaultProject({ id: "a".repeat(120) }).id.length, 120);
  assert.throws(() => createDefaultProject({ id: "a".repeat(121) }), /120.*121/);
  assert.throws(() => createDefaultProject({ id: "bad\/id" }), /必須以英數字開頭/);
  await assert.rejects(new StudioStore().getProject(" "), /不可為空白/);
});

test("HTTP import accepts the reported legacy ID and preserves existing projects", async () => {
  const store = new StudioStore();
  const original = createDefaultProject({
    id: legacyId, name: "opendata", version: "1.0.18",
    steps: [{ id: "stable-step-id", name: "等待", kind: "wait", enabled: true, value: "10" }]
  });
  await store.saveProject(original);
  const route = await createStudioRouter();
  const server = http.createServer((req, res) => {
    void route(req, res, new URL(req.url ?? "/", "http://localhost"))
      .then(handled => { if (!handled) { res.statusCode = 404; res.end(); } })
      .catch(error => { res.statusCode = 500; res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/studio/projects`;
    let input = original;
    const ids = new Set([original.id]);
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`${base}/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: input })
      });
      const body = await response.json();
      assert.equal(response.status, 201, JSON.stringify(body));
      assert.ok(!ids.has(body.project.id));
      ids.add(body.project.id);
      assert.deepEqual(body.project.steps, JSON.parse(JSON.stringify(original.steps)));
      assert.equal(body.project.version, original.version);
      assert.equal((await store.getProject(body.project.id)).id, body.project.id);
      input = body.project;
    }
    assert.equal((await store.getProject(original.id)).name, original.name);
    assert.equal(ids.size, 4);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
