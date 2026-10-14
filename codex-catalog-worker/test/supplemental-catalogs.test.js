import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWorker } from "../src/index.js";
import { appendSupplementalCatalogs } from "../src/supplemental-catalogs.js";

const template = JSON.parse(await readFile(new URL("../../examples/model.catalog.json", import.meta.url), "utf8")).models[0];
const model = (slug) => ({ ...structuredClone(template), slug, display_name: slug });
const request = () => new Request("https://catalog.example/backend-api/codex/models?client_version=0.162.1", {
  headers: { Authorization: "Bearer client-token" },
});
const env = {
  EXTRA_CATALOG_REPOSITORY: "test-owner/test-repo", EXTRA_CATALOG_DIRECTORY: "catalogs",
  EXTRA_CATALOG_REF: "main", EXTRA_CATALOG_CACHE_TTL: "300",
};
const sha = (character) => character.repeat(40);
const treeEntry = (path, character, extra = {}) => ({ path, type: "blob", mode: "100644", sha: sha(character), ...extra });

test("all JSON files, including nested files, append in path order and retain original fields", async () => {
  const calls = [];
  let activeBlobs = 0;
  let maxActiveBlobs = 0;
  const worker = createWorker({ fetchImpl: async function (url, options) {
    assert.equal(this, undefined);
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, undefined);
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ marker: "keep", models: [model("official-model")] });
    if (url.includes("/trees/")) return Response.json({ sha: sha("a"), truncated: false, tree: [
      treeEntry("catalogs/nested/glm.json", "c"), treeEntry("catalogs/deepseek.json", "b"),
      treeEntry("catalogs/README.md", "d"), treeEntry("examples/model.catalog.json", "e"),
      treeEntry("catalogs/link.json", "f", { mode: "120000" }),
    ] });
    activeBlobs++;
    maxActiveBlobs = Math.max(maxActiveBlobs, activeBlobs);
    await new Promise((resolve) => setImmediate(resolve));
    activeBlobs--;
    if (url.endsWith(sha("b"))) return Response.json({ models: [model("deepseek-example")] });
    if (url.endsWith(sha("c"))) return Response.json({ models: [model("glm-example")] });
    assert.fail(`Unexpected source: ${url}`);
  } });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.marker, "keep");
  assert.deepEqual(body.models.map((entry) => entry.slug), ["official-model", "deepseek-example", "glm-example"]);
  assert.deepEqual(body.models[1], model("deepseek-example"));
  assert.equal(response.headers.get("x-catalog-extras-status"), "ok");
  assert.equal(response.headers.get("x-catalog-extra-files"), "2");
  assert.equal(response.headers.get("x-catalog-extra-models"), "2");
  assert.equal(response.headers.get("x-catalog-extra-revision"), sha("a"));
  assert.equal(calls.length, 4);
  assert.equal(maxActiveBlobs, 2);
  assert.equal(calls.find(({ url }) => url.includes("/trees/")).options.cf.cacheTtlByStatus["200-299"], 300);
  assert.equal(calls.find(({ url }) => url.includes("/blobs/")).options.headers.Accept, "application/vnd.github.raw+json");
});

test("empty placeholder catalogs add no models", async () => {
  const worker = createWorker({ fetchImpl: async (url) => {
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ models: [model("official")] });
    if (url.includes("/trees/")) return Response.json({ sha: sha("a"), truncated: false, tree: [treeEntry("catalogs/deepseek.json", "b")] });
    return Response.json({ models: [] });
  } });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-catalog-extra-models"), "0");
  assert.equal(response.headers.get("x-catalog-extra-files"), "1");
});

test("a newly committed JSON file is discovered without changing Worker configuration", async () => {
  let revision = 1;
  const worker = createWorker({ fetchImpl: async (url) => {
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ models: [model("official")] });
    if (url.includes("/trees/")) return Response.json({
      sha: sha(revision === 1 ? "a" : "d"), truncated: false,
      tree: revision === 1 ? [treeEntry("catalogs/deepseek.json", "b")]
        : [treeEntry("catalogs/deepseek.json", "b"), treeEntry("catalogs/glm.json", "c")],
    });
    return Response.json({ models: [model(url.endsWith(sha("b")) ? "deepseek-example" : "glm-example")] });
  } });
  const first = await worker.fetch(request(), env);
  revision = 2;
  const second = await worker.fetch(request(), env);
  assert.equal((await first.json()).models.length, 2);
  assert.equal((await second.json()).models.length, 3);
  assert.notEqual(first.headers.get("etag"), second.headers.get("etag"));
});

test("failed directory discovery preserves official catalog or errors according to policy", async () => {
  const worker = createWorker({ fetchImpl: async (url) => url.startsWith("https://raw.githubusercontent.com/")
    ? Response.json({ models: [model("official")] }) : new Response(null, { status: 403 }) });
  const skipped = await worker.fetch(request(), env);
  assert.equal(skipped.status, 200);
  assert.equal(skipped.headers.get("x-catalog-extras-status"), "failed");
  assert.equal((await skipped.json()).models.length, 1);
  assert.equal((await worker.fetch(request(), { ...env, EXTRA_CATALOG_FAILURE_MODE: "error" })).status, 502);
});

test("an invalid extra file is skipped while valid files still append", async () => {
  const worker = createWorker({ fetchImpl: async (url) => {
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ models: [model("official")] });
    if (url.includes("/trees/")) return Response.json({ sha: sha("a"), truncated: false, tree: [
      treeEntry("catalogs/deepseek.json", "b"), treeEntry("catalogs/glm.json", "c"),
    ] });
    return url.endsWith(sha("b")) ? Response.json({ models: [{ slug: "invalid" }] })
      : Response.json({ models: [model("glm-example")] });
  } });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-catalog-extras-status"), "partial");
  assert.deepEqual((await response.json()).models.map((entry) => entry.slug), ["official", "glm-example"]);
});

test("duplicate slugs cannot silently replace official or extra models", () => {
  const official = { models: [model("official")] };
  assert.throws(() => appendSupplementalCatalogs(official, [{ path: "catalogs/a.json", catalog: { models: [model("official")] } }]),
    (error) => error.code === "duplicate_model_slug");
  assert.throws(() => appendSupplementalCatalogs(official, [
    { path: "catalogs/a.json", catalog: { models: [model("duplicate")] } },
    { path: "catalogs/b.json", catalog: { models: [model("duplicate")] } },
  ]), (error) => error.code === "duplicate_model_slug");
});

test("truncated trees do not publish a misleading partial file list", async () => {
  const worker = createWorker({ fetchImpl: async (url) => url.startsWith("https://raw.githubusercontent.com/")
    ? Response.json({ models: [model("official")] }) : Response.json({ sha: sha("a"), truncated: true, tree: [] }) });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-catalog-extras-status"), "failed");
});

test("GitHub API credentials are scoped to GitHub API and never replace caller auth", async () => {
  const calls = [];
  const worker = createWorker({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith("https://raw.githubusercontent.com/")) return Response.json({ models: [model("official")] });
    return Response.json({ sha: sha("a"), truncated: false, tree: [] });
  } });
  const response = await worker.fetch(request(), { ...env, EXTRA_GITHUB_TOKEN: "api-test-token" });
  assert.equal(response.status, 200);
  assert.equal(calls.find(({ url }) => url.startsWith("https://raw.githubusercontent.com/")).options.headers.Authorization, undefined);
  assert.equal(calls.find(({ url }) => url.startsWith("https://api.github.com/")).options.headers.Authorization, "Bearer api-test-token");
});
