import { CatalogError, readLimitedBody, ttl, validateCatalog } from "./catalog.js";

const API_ORIGIN = "https://api.github.com";
const MAX_FILES = 32;
const CONCURRENCY = 4;

export function supplementalConfig(env) {
  const repository = env.EXTRA_CATALOG_REPOSITORY ?? "";
  if (!repository) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || repository.split("/").some((part) => [".", ".."].includes(part))) {
    throw new CatalogError(500, "invalid_extra_repository", "EXTRA_CATALOG_REPOSITORY must be owner/repository.");
  }
  const directory = (env.EXTRA_CATALOG_DIRECTORY ?? "catalogs").replace(/^\/+|\/+$/g, "");
  if (!directory || directory.split("/").some((part) => !part || [".", ".."].includes(part))) {
    throw new CatalogError(500, "invalid_extra_directory", "Extra catalog directory must be a relative repository path.");
  }
  const ref = env.EXTRA_CATALOG_REF ?? "main";
  if (!ref || ref.length > 200 || /[\x00-\x20?#]/.test(ref)) {
    throw new CatalogError(500, "invalid_extra_ref", "Extra catalog ref must be a branch, tag, or commit.");
  }
  const failureMode = env.EXTRA_CATALOG_FAILURE_MODE ?? "skip";
  if (!["skip", "error"].includes(failureMode)) {
    throw new CatalogError(500, "invalid_extra_failure_mode", "Extra catalog failure mode must be skip or error.");
  }
  return { repository, directory, ref, failureMode, cacheTtl: ttl(env.EXTRA_CATALOG_CACHE_TTL, 300) };
}

async function apiJson(path, options, accept = "application/vnd.github+json", cacheTtl = options.cacheTtl) {
  const { fetchImpl } = options;
  const headers = {
    Accept: accept,
    "User-Agent": "codex-catalog-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // This credential, if configured, is independent of the client's credentials.
  if (options.githubToken) headers.Authorization = `Bearer ${options.githubToken}`;
  try {
    const response = await fetchImpl(`${API_ORIGIN}${path}`, {
      method: "GET", headers, redirect: "manual", signal: options.signal,
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": cacheTtl, "400-599": -1 } },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new CatalogError(502, "extra_source_unavailable", `Extra catalog GitHub API returned HTTP ${response.status}.`);
    }
    const body = await readLimitedBody(response, "Extra catalog GitHub API");
    try {
      return JSON.parse(body);
    } catch {
      throw new CatalogError(502, "invalid_extra_json", "Extra catalog GitHub API returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError(502, "extra_source_unavailable", "Extra catalog GitHub API request failed or timed out.");
  }
}

function reportFailure(file, error) {
  const code = error instanceof CatalogError ? error.code : "extra_source_unavailable";
  console.warn(JSON.stringify({ event: "extra_catalog_failed", file, code }));
  return { file, code };
}

async function mapConcurrent(items, operation) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const position = index++;
      try {
        results[position] = { status: "fulfilled", value: await operation(items[position]) };
      } catch (reason) {
        results[position] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

export async function loadSupplementalCatalogs(env, fetchImpl, signal) {
  const config = supplementalConfig(env);
  if (!config) return { status: "disabled", revision: null, catalogs: [], failures: [] };
  const options = { ...config, fetchImpl, signal, githubToken: env.EXTRA_GITHUB_TOKEN };
  const basePath = `/repos/${config.repository.split("/").map(encodeURIComponent).join("/")}/git`;
  let files;
  let revision;
  try {
    const tree = await apiJson(`${basePath}/trees/${encodeURIComponent(config.ref)}?recursive=1`, options);
    if (!Array.isArray(tree.tree) || tree.truncated !== false || !/^[a-f0-9]{40,64}$/.test(tree.sha)) {
      throw new CatalogError(502, "invalid_extra_tree", "GitHub repository tree is invalid or truncated.");
    }
    revision = tree.sha;
    files = tree.tree.filter((entry) => entry.type === "blob"
      && ["100644", "100755"].includes(entry.mode)
      && entry.path.startsWith(`${config.directory}/`) && entry.path.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (files.length > MAX_FILES || files.some((file) => !/^[a-f0-9]{40,64}$/.test(file.sha))) {
      throw new CatalogError(502, "invalid_extra_tree", `Extra catalog directory must contain at most ${MAX_FILES} regular JSON files.`);
    }
  } catch (error) {
    if (config.failureMode === "error") throw error;
    return { status: "failed", revision: null, catalogs: [], failures: [reportFailure(config.directory, error)] };
  }

  // Read immutable blobs selected by the tree snapshot. A later commit cannot mix revisions.
  const results = await mapConcurrent(files, async (file) => {
    const catalog = await apiJson(`${basePath}/blobs/${file.sha}`, options, "application/vnd.github.raw+json", 86400);
    validateCatalog(catalog, { allowEmpty: true });
    return { path: file.path, catalog };
  });
  const catalogs = [];
  const failures = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === "fulfilled") catalogs.push(result.value);
    else {
      if (config.failureMode === "error") throw result.reason;
      failures.push(reportFailure(files[index].path, result.reason));
    }
  }
  return { status: failures.length ? "partial" : "ok", revision, catalogs, failures };
}

export function appendSupplementalCatalogs(officialCatalog, supplements) {
  const result = structuredClone(officialCatalog);
  const known = new Set(result.models.map((model) => model.slug));
  const appendedModels = [];
  for (const { path, catalog } of supplements) {
    for (const model of catalog.models) {
      if (known.has(model.slug)) {
        throw new CatalogError(502, "duplicate_model_slug", `Model ${model.slug} in ${path} duplicates an existing model.`);
      }
      known.add(model.slug);
      appendedModels.push(model.slug);
      result.models.push(structuredClone(model));
    }
  }
  validateCatalog(result);
  return { catalog: result, appendedModels };
}
