import { CatalogError, loadCatalog, parseClientVersion, patchCatalog, serializeCatalog, withCatalogBudget } from "./catalog.js";
import { appendSupplementalCatalogs, loadSupplementalCatalogs } from "./supplemental-catalogs.js";
import { RULES } from "./patch-rules.js";

function errorResponse(status, code, message) {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function etagFor(body) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hash}"`;
}

export function createWorker({ fetchImpl = fetch, rules = RULES } = {}) {
  return {
    async fetch(request, env = {}) {
      try {
        const url = new URL(request.url);
        if (url.pathname !== (env.CATALOG_PATH ?? "/backend-api/codex/models")) {
          if (env.PASSTHROUGH_OTHER_PATHS === "true") return await fetchImpl(request);
          return errorResponse(404, "not_found", "Catalog route not found.");
        }
        if (request.method !== "GET") {
          return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
        }
        if (env.CATALOG_BEARER_TOKEN
          && request.headers.get("Authorization") !== `Bearer ${env.CATALOG_BEARER_TOKEN}`) {
          return errorResponse(401, "unauthorized", "Invalid catalog bearer token.");
        }
        const version = parseClientVersion(url.searchParams);
        const [source, extras] = await withCatalogBudget(async (signal) => {
          const results = await Promise.allSettled([
            loadCatalog(version, env, rules, fetchImpl, signal),
            loadSupplementalCatalogs(env, fetchImpl, signal),
          ]);
          for (const result of results) if (result.status === "rejected") throw result.reason;
          return results.map((result) => result.value);
        });
        const { catalog: combined, appendedModels } = appendSupplementalCatalogs(source.catalog, extras.catalogs);
        const { catalog, patchedModels } = patchCatalog(combined, version, rules);
        const body = serializeCatalog(catalog);
        const response = new Response(body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
            ETag: await etagFor(body),
            "X-Catalog-Client-Version": version,
            "X-Catalog-Source-Ref": source.ref,
            "X-Catalog-Source-Path": source.path,
            "X-Catalog-Fallback": String(source.fallback),
            "X-Catalog-Patched-Models": patchedModels.join(","),
            "X-Catalog-Extras-Status": extras.status,
            "X-Catalog-Extra-Files": String(extras.catalogs.length),
            "X-Catalog-Extra-Models": String(appendedModels.length),
            ...(extras.revision ? { "X-Catalog-Extra-Revision": extras.revision } : {}),
          },
        });
        console.log(JSON.stringify({
          event: "catalog_served", client_version: version, source_ref: source.ref,
          source_path: source.path, fallback: source.fallback,
          model_count: catalog.models.length, patched_models: patchedModels,
          extras_status: extras.status, extras_revision: extras.revision,
          extra_files: extras.catalogs.map((entry) => entry.path),
          appended_models: appendedModels, extra_failures: extras.failures,
        }));
        return response;
      } catch (error) {
        if (error instanceof CatalogError) return errorResponse(error.status, error.code, error.message);
        console.error("catalog_internal_error");
        return errorResponse(500, "internal_error", "Catalog processing failed.");
      }
    },
  };
}

export default createWorker();
