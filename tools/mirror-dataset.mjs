// Mirrors the GTNH 2.9.0 recipe dataset (stable-2.9.0) published by gtnhplanretro.tfaluc.com,
// so this planner runs without depending on any external site. For personal use.
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE = "https://gtnhplanretro.tfaluc.com";
const VER = "stable-2.9.0";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Usage: node tools/mirror-dataset.mjs [outDir]   (default: <repo>/public, so files land in public/datasets/gtnh)
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "public"));
const NEI_LOCAL = path.join(REPO, "public");
const VDIR = `/datasets/gtnh/${VER}`;
const UA = "gtnh-mirror/1.0";
const stats = { ok: 0, skipped: 0, missing: [], errors: [], bytes: 0, cats: {} };
const cat = (c, k) => ((stats.cats[c] ??= { ok: 0, skipped: 0, missing: 0, error: 0 })[k]++);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dest = (u) => path.join(OUT, u);

async function exists(f) { try { return (await fs.stat(f)).size > 0; } catch { return false; } }

async function fetchBuf(u) {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(BASE + encodeURI(decodeURI(u)), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      const ct = r.headers.get("content-type") || "";
      if (r.status === 404 || (r.status === 200 && ct.includes("text/html"))) return null;
      if (r.status !== 200) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await sleep(500 * 2 ** a); }
  }
  throw last;
}

// returns "ok" | "skipped" | "missing" | "error"
async function get(u, category) {
  const f = dest(u);
  if (await exists(f)) { stats.skipped++; cat(category, "skipped"); return "skipped"; }
  try {
    const b = await fetchBuf(u);
    if (!b) { stats.missing.push(u); cat(category, "missing"); return "missing"; }
    if (u.endsWith(".json.gz")) JSON.parse(zlib.gunzipSync(b).toString("utf8"));
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, b);
    stats.ok++; stats.bytes += b.length; cat(category, "ok"); return "ok";
  } catch (e) { stats.errors.push({ u, e: String(e) }); cat(category, "error"); return "error"; }
}

async function pool(items, fn, n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const readGz = async (u) => JSON.parse(zlib.gunzipSync(await fs.readFile(dest(u))).toString("utf8"));
function walk(o, set) {
  if (typeof o === "string") { if (o.startsWith("/datasets/gtnh/") || o.startsWith("/nei/")) set.add(o); }
  else if (Array.isArray(o)) for (const x of o) walk(x, set);
  else if (o && typeof o === "object") for (const k in o) walk(o[k], set);
}

// 1 manifest
const mu = "/datasets/gtnh/datasets.manifest.json";
const mb = await fetchBuf(mu);
const man = JSON.parse(mb.toString("utf8"));
await fs.mkdir(path.dirname(dest(mu)), { recursive: true });
await fs.writeFile(dest("/datasets/gtnh/datasets.manifest.upstream.json"), mb);
const entry = man.versions.find((v) => v.id === VER);
await fs.writeFile(dest(mu), JSON.stringify({ ...man, latestStableVersion: VER, versions: [entry] }, null, 2));

// 2/3 core + locales + probes
const core = [entry.recipeDatasetPath, entry.resourceIndexPath, entry.recipeIndexPath, entry.recipeLookupIndexPath];
await pool(core, (u) => get(u, "core"));
await pool(["ru_RU", "zh_CN"].map((l) => `${VDIR}/locales/${l}.json.gz`), (u) => get(u, "locales"));
const probes = ["oracle-report.json", "crops.json.gz", "mobs.json.gz", "catalog.json.gz", "machines.json.gz"].map((n) => `${VDIR}/${n}`);
const probeRes = {};
await pool(probes, async (u) => { probeRes[u] = await get(u, "probes"); });
// probes missing are not "missing" errors of note, but keep them listed separately
const probeMissing = probes.filter((u) => probeRes[u] === "missing");
stats.missing = stats.missing.filter((u) => !probeMissing.includes(u));

// 4 shards
const lookup = await readGz(entry.recipeLookupIndexPath);
const shardPaths = lookup.shards.map((s) => s.path);
await pool(shardPaths, (u) => get(u, "shards"));

// 5 assets
const assets = new Set();
const ri = await readGz(entry.resourceIndexPath);
walk(ri, assets);
let n = 0;
for (const u of shardPaths) {
  if (!(await exists(dest(u)))) continue;
  walk(await readGz(u), assets);
  if (++n % 200 === 0) console.log("scanned shards", n);
}
const shardSet = new Set(shardPaths);
const toGet = [...assets].filter((u) => !shardSet.has(u) && !core.includes(u));
const neiLocal = [];
let done = 0;
await pool(toGet, async (u) => {
  if (u.startsWith("/nei/") && (await exists(path.join(NEI_LOCAL, u)))) { neiLocal.push(u); cat("assets-nei-local", "skipped"); return; }
  await get(u, u.startsWith("/nei/") ? "assets-nei" : "assets-datasets");
  if (++done % 500 === 0) console.log("assets", done, "/", toGet.length);
});

// verify all json.gz
const bad = [];
async function* files(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* files(p); else yield p; } }
let verified = 0;
for await (const p of files(OUT)) if (p.endsWith(".json.gz")) { try { JSON.parse(zlib.gunzipSync(await fs.readFile(p)).toString("utf8")); verified++; } catch (e) { bad.push(p); } }

// checksum
let checksum = {};
try {
  const h = createHash("sha256");
  for (const name of ["resource-index.json.gz", "recipe-index.json.gz", "recipe-lookup-index.json.gz", "recipes.json.gz"]) {
    const buf = await fs.readFile(dest(`${VDIR}/${name}`));
    h.update(name).update("\0").update(createHash("sha256").update(buf).digest());
  }
  const got = h.digest("hex");
  checksum = { expected: entry.checksumSha256, got, match: got === entry.checksumSha256 };
} catch (e) { checksum = { expected: entry.checksumSha256, note: "not computable: " + e.code + " " + e.path }; }

const report = {
  generatedAt: new Date().toISOString(), version: VER,
  counts: { ...stats.cats, uniqueAssetPaths: assets.size, shardsListed: shardPaths.length, neiAlreadyLocal: neiLocal.length, jsonGzVerified: verified },
  totalBytesDownloadedThisRun: stats.bytes, missing: stats.missing, probesMissing: probeMissing,
  probesPresent: probes.filter((u) => !probeMissing.includes(u)), errors: stats.errors, badJsonGz: bad, checksum,
};
await fs.writeFile(dest(`${VDIR}/MIRROR-REPORT.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 4000));
