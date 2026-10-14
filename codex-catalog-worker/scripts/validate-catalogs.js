import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateCatalog } from "../src/catalog.js";

const root = fileURLToPath(new URL("../../catalogs/", import.meta.url));
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(file);
  }
}
await collect(root);
files.sort();
const known = new Set();
for (const file of files) {
  const catalog = JSON.parse(await readFile(file, "utf8"));
  validateCatalog(catalog, { allowEmpty: true });
  for (const model of catalog.models) {
    if (known.has(model.slug)) throw new Error(`Duplicate model slug: ${model.slug}`);
    known.add(model.slug);
  }
  console.log(`${path.relative(root, file)}: ${catalog.models.length} models`);
}
console.log(`Validated ${files.length} files and ${known.size} models.`);
