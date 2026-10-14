const RAW_ORIGIN = "https://raw.githubusercontent.com";
const CATALOG_PATHS = [
  "codex-rs/models-manager/models.json",
  "codex-rs/core/models.json",
];
const MAX_CATALOG_BYTES = 1024 * 1024;
// Codex 0.162.1 gives its whole catalog request five seconds.
const UPSTREAM_BUDGET_MS = 4500;
const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REF_PATTERN = /^rust-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class CatalogError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseClientVersion(searchParams) {
  const values = searchParams.getAll("client_version");
  if (values.length !== 1 || values[0].length > 64 || !VERSION_PATTERN.test(values[0])) {
    throw new CatalogError(400, "invalid_client_version", "Provide exactly one client_version in X.Y.Z format.");
  }
  // Codex sends a whole version without its prerelease/build suffix.
  return values[0].match(/^\d+\.\d+\.\d+/)[0];
}

function validateRef(ref) {
  if (ref !== "main" && !REF_PATTERN.test(ref)) {
    throw new CatalogError(500, "invalid_catalog_ref", "Catalog refs must be main or a rust-vX.Y.Z release tag.");
  }
  return ref;
}

export function ttl(value, defaultValue) {
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 604800) {
    throw new CatalogError(500, "invalid_cache_ttl", "Cache TTL must be an integer from 0 to 604800 seconds.");
  }
  return parsed;
}

function githubUrl(ref, path) {
  const reference = ref === "main" ? "heads/main" : `tags/${encodeURIComponent(ref)}`;
  return `${RAW_ORIGIN}/openai/codex/refs/${reference}/${path}`;
}

export async function readLimitedBody(response, source = "GitHub") {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) {
    await response.body?.cancel();
    throw new CatalogError(502, "catalog_too_large", `${source} response exceeds the 1 MiB limit.`);
  }
  if (!response.body) {
    throw new CatalogError(502, "empty_catalog", `${source} returned an empty response.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new CatalogError(502, "catalog_too_large", `${source} response exceeds the 1 MiB limit.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function fetchAtRef(ref, options) {
  const cacheTtl = ref === "main" ? options.mainTtl : options.tagTtl;
  // The Workers fetch function must not receive options as its `this` value.
  const { fetchImpl } = options;
  for (const path of CATALOG_PATHS) {
    try {
      // Never forward the caller's Authorization, Cookie, or routing headers.
      const response = await fetchImpl(githubUrl(ref, path), {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "codex-catalog-worker" },
        redirect: "manual",
        signal: options.signal,
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: {
            "200-299": cacheTtl,
            "404": 60,
            "400-403": -1,
            "405-599": -1,
          },
        },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CatalogError(502, "github_unavailable", `GitHub returned HTTP ${response.status}.`);
      }
      const body = await readLimitedBody(response);
      let catalog;
      try {
        catalog = JSON.parse(body);
      } catch {
        throw new CatalogError(502, "invalid_upstream_json", "GitHub did not return valid catalog JSON.");
      }
      validateCatalog(catalog);
      return { catalog, ref, path };
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      console.warn(JSON.stringify({
        event: "github_fetch_failed", source_ref: ref, source_path: path,
        error_name: error?.name, error_message: error?.message,
      }));
      throw new CatalogError(502, "github_unavailable", "The GitHub catalog request failed or timed out.");
    }
  }
  return null;
}

export async function withCatalogBudget(operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_BUDGET_MS);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadCatalog(version, env, rules, fetchImpl = fetch, signal) {
  if (!signal) {
    return withCatalogBudget((budgetSignal) => loadCatalog(version, env, rules, fetchImpl, budgetSignal));
  }
  const selectedRef = validateRef(rules.versionRefs?.[version] ?? `rust-v${version}`);
  const fallbackRef = validateRef(env.FALLBACK_REF ?? "main");
  const options = {
    fetchImpl,
    tagTtl: ttl(env.TAG_CACHE_TTL, 86400),
    mainTtl: ttl(env.MAIN_CACHE_TTL, 300),
    signal,
  };
  const exact = await fetchAtRef(selectedRef, options);
  if (exact) return { ...exact, fallback: false };
  if (fallbackRef !== selectedRef) {
    const fallback = await fetchAtRef(fallbackRef, options);
    if (fallback) return { ...fallback, fallback: true };
  }
  throw new CatalogError(502, "catalog_not_found", "Neither the requested release nor the fallback contains a catalog.");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(original, patch) {
  if (!isObject(patch)) return structuredClone(patch);
  const result = isObject(original) ? structuredClone(original) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new CatalogError(500, "invalid_patch_key", "Patch contains a reserved object key.");
    }
    result[key] = isObject(value) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

export function patchCatalog(catalog, version, rules) {
  const versionRules = rules.versions?.[version] ?? {};
  const patchedModels = [];
  const result = structuredClone(catalog);
  result.models = catalog.models.map((original) => {
    let model = structuredClone(original);
    if (rules.disableResponsesLite && model.use_responses_lite === true) {
      model.use_responses_lite = false;
    }
    model = deepMerge(model, rules.allModels ?? {});
    model = deepMerge(model, rules.models?.[original.slug] ?? {});
    model = deepMerge(model, versionRules.allModels ?? {});
    model = deepMerge(model, versionRules.models?.[original.slug] ?? {});
    if (JSON.stringify(original) !== JSON.stringify(model)) patchedModels.push(model.slug);
    return model;
  });
  validateCatalog(result);
  return { catalog: result, patchedModels };
}

export function validateCatalog(catalog, { allowEmpty = false } = {}) {
  if (!isObject(catalog) || !Array.isArray(catalog.models) || (!allowEmpty && catalog.models.length === 0)) {
    throw new CatalogError(502, "invalid_catalog", `Catalog must contain ${allowEmpty ? "a" : "a non-empty"} models array.`);
  }
  const slugs = new Set();
  for (const model of catalog.models) {
    if (!isObject(model) || typeof model.slug !== "string" || !model.slug.trim() || slugs.has(model.slug)) {
      throw new CatalogError(502, "invalid_catalog", "Model slugs must be unique, non-empty strings.");
    }
    slugs.add(model.slug);
    if (typeof model.display_name !== "string" || !Array.isArray(model.supported_reasoning_levels)
      || typeof model.shell_type !== "string" || typeof model.visibility !== "string"
      || typeof model.supported_in_api !== "boolean" || !Number.isInteger(model.priority)
      || typeof model.support_verbosity !== "boolean" || !isObject(model.truncation_policy)
      || !Array.isArray(model.experimental_supported_tools)) {
      throw new CatalogError(502, "invalid_catalog", `Model ${model.slug} is missing required Codex catalog fields.`);
    }
    if (typeof model.base_instructions !== "string"
      && typeof model.model_messages?.instructions_template !== "string") {
      throw new CatalogError(502, "invalid_catalog", `Model ${model.slug} has no instruction template.`);
    }
    for (const field of ["context_window", "max_context_window"]) {
      if (model[field] !== undefined && model[field] !== null
        && (!Number.isSafeInteger(model[field]) || model[field] <= 0)) {
        throw new CatalogError(502, "invalid_catalog", `Model ${model.slug} has an invalid ${field}.`);
      }
    }
  }
}

export function serializeCatalog(catalog) {
  const body = JSON.stringify(catalog);
  if (new TextEncoder().encode(body).byteLength > MAX_CATALOG_BYTES) {
    throw new CatalogError(502, "catalog_too_large", "Patched catalog exceeds Codex's 1 MiB response limit.");
  }
  return body;
}
