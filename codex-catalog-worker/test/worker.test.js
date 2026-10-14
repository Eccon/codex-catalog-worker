import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge, parseClientVersion, patchCatalog } from "../src/catalog.js";
import { createWorker } from "../src/index.js";
import { RULES } from "../src/patch-rules.js";

function model(slug, extra = {}) {
  return {
    slug, display_name: slug, supported_reasoning_levels: [], shell_type: "unified_exec",
    visibility: "list", supported_in_api: true, priority: 0, support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [],
    context_window: 272000, max_context_window: 872000,
    model_messages: { instructions_template: "Original instructions", tools: { enabled: true } },
    ...extra,
  };
}

function request(version = "0.162.1", options = {}) {
  return new Request(`https://catalog.example/backend-api/codex/models?client_version=${version}`, options);
}

test("requested field changes preserve prompts, capabilities, unknown fields, and original input", () => {
  const input = { extra_top_level: "keep", models: [
    model("gpt-6.1-sol", { use_responses_lite: true, future_field: { keep: 1 } }),
    model("gpt-6-astra", { use_responses_lite: true }),
    model("gpt-5.6-sol", { use_responses_lite: false }),
    model("other", { use_responses_lite: true }),
    model("legacy"),
  ] };
  const snapshot = structuredClone(input);
  const { catalog, patchedModels } = patchCatalog(input, "0.162.1", RULES);
  assert.deepEqual(input, snapshot);
  assert.equal(catalog.extra_top_level, "keep");
  for (const original of input.models) {
    const output = catalog.models.find((entry) => entry.slug === original.slug);
    const expected = structuredClone(original);
    if (expected.use_responses_lite === true) expected.use_responses_lite = false;
    const context = RULES.models[original.slug]?.context_window;
    if (context) expected.context_window = context;
    assert.deepEqual(output, expected);
  }
  assert.deepEqual(patchedModels, ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "other"]);
  assert.equal(Object.hasOwn(catalog.models[4], "use_responses_lite"), false);
});

test("nested objects merge, arrays replace, and explicit null remains null", () => {
  assert.deepEqual(deepMerge(
    { nested: { a: 1, b: 2 }, items: [1, 2], nullable: { a: 1 }, keep: true },
    { nested: { a: 5 }, items: [3], nullable: null },
  ), { nested: { a: 5, b: 2 }, items: [3], nullable: null, keep: true });
  assert.throws(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.equal({}.polluted, undefined);
});

test("version-specific rules apply last without adding missing models", () => {
  const rules = { ...RULES, versions: { "0.162.1": { models: { "gpt-6.1-sol": { context_window: 600000 } } } } };
  const { catalog } = patchCatalog({ models: [model("gpt-6.1-sol")] }, "0.162.1", rules);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].context_window, 600000);
  assert.equal(catalog.models[0].max_context_window, 872000);
});

test("an exact tag loads the current path and does not leak request credentials", async () => {
  const calls = [];
  const worker = createWorker({ fetchImpl: async function (url, options) {
    assert.equal(this, undefined);
    calls.push({ url, options });
    return Response.json({ models: [model("gpt-6.1-sol", { use_responses_lite: true })] });
  } });
  const response = await worker.fetch(request("0.162.1", {
    headers: { Authorization: "Bearer client-test-token", Cookie: "private=client-value" },
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://raw.githubusercontent.com/openai/codex/refs/tags/rust-v0.162.1/codex-rs/models-manager/models.json");
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[0].options.cf.cacheTtlByStatus["200-299"], 86400);
  assert.equal(response.headers.get("x-catalog-fallback"), "false");
  assert.match(response.headers.get("etag"), /^"[a-f0-9]{64}"$/);
  const body = await response.json();
  assert.equal(body.models[0].context_window, 500000);
  assert.equal(body.models[0].use_responses_lite, false);
});

test("old releases use core/models.json before falling back to main", async () => {
  const calls = [];
  const worker = createWorker({ fetchImpl: async (url) => {
    calls.push(url);
    if (url.endsWith("models-manager/models.json")) return new Response(null, { status: 404 });
    return Response.json({ models: [model("legacy-model")] });
  } });
  const response = await worker.fetch(request("0.100.0"));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("refs/tags/rust-v0.100.0/codex-rs/core/models.json"));
  assert.equal(response.headers.get("x-catalog-source-ref"), "rust-v0.100.0");
  assert.equal(response.headers.get("x-catalog-fallback"), "false");
});

test("missing release paths fall back to main and identify the source", async () => {
  const calls = [];
  const worker = createWorker({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/refs/tags/")) return new Response(null, { status: 404 });
    return Response.json({ models: [model("gpt-6-astra")] });
  } });
  const response = await worker.fetch(request("0.999.0"));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(response.headers.get("x-catalog-source-ref"), "main");
  assert.equal(response.headers.get("x-catalog-fallback"), "true");
  assert.equal(calls[2].options.cf.cacheTtlByStatus["200-299"], 300);
  assert.equal((await response.json()).models[0].context_window, 300000);
});

test("an explicitly mapped prerelease ref overrides the stable tag", async () => {
  const calls = [];
  const worker = createWorker({
    rules: { ...RULES, versionRefs: { "0.163.0": "rust-v0.163.0-alpha.1" } },
    fetchImpl: async (url) => { calls.push(url); return Response.json({ models: [model("other")] }); },
  });
  const response = await worker.fetch(request("0.163.0"));
  assert.equal(response.status, 200);
  assert.ok(calls[0].includes("rust-v0.163.0-alpha.1/"));
});

test("a fixed fallback tag can replace main", async () => {
  const calls = [];
  const worker = createWorker({ fetchImpl: async (url) => {
    calls.push(url);
    return url.includes("rust-v0.999.0")
      ? new Response(null, { status: 404 }) : Response.json({ models: [model("other")] });
  } });
  const response = await worker.fetch(request("0.999.0"), { FALLBACK_REF: "rust-v0.162.1" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-catalog-source-ref"), "rust-v0.162.1");
  assert.equal(calls.length, 3);
});

test("transient errors and malformed successful responses do not silently select main", async () => {
  for (const upstream of [new Response(null, { status: 503 }), new Response("not json"), Response.json({ data: [] })]) {
    const calls = [];
    const worker = createWorker({ fetchImpl: async (url) => { calls.push(url); return upstream; } });
    const response = await worker.fetch(request());
    assert.equal(response.status, 502);
    assert.equal(calls.length, 1);
  }
});

test("invalid/duplicate versions and wrong authorization do not reach GitHub", async () => {
  let calls = 0;
  const worker = createWorker({ fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); } });
  for (const suffix of ["", "?client_version=../../main", "?client_version=0.162.1&client_version=0.162.0"]) {
    const response = await worker.fetch(new Request(`https://catalog.example/backend-api/codex/models${suffix}`));
    assert.equal(response.status, 400);
  }
  const response = await worker.fetch(request(), { CATALOG_BEARER_TOKEN: "worker-test-token" });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
  assert.equal(parseClientVersion(new URLSearchParams("client_version=0.163.0-alpha.1")), "0.163.0");
});

test("route and method checks isolate the catalog endpoint", async () => {
  let calls = 0;
  const worker = createWorker({ fetchImpl: async () => { calls++; return new Response("origin response"); } });
  const unrelated = new Request("https://catalog.example/v1/responses");
  assert.equal((await worker.fetch(unrelated)).status, 404);
  assert.equal((await worker.fetch(request("0.162.1", { method: "POST" }))).status, 405);
  assert.equal(calls, 0);
  assert.equal(await (await worker.fetch(unrelated, { PASSTHROUGH_OTHER_PATHS: "true" })).text(), "origin response");
  assert.equal(calls, 1);
});

test("oversized catalogs fail before returning an incompatible response", async () => {
  const worker = createWorker({ fetchImpl: async () => Response.json({ models: [
    model("large", { base_instructions: "x".repeat(1024 * 1024) }),
  ] }) });
  const response = await worker.fetch(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "catalog_too_large");
});
