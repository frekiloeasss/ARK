"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const port = Number(arg("--port", "6505"));
const host = arg("--host", "127.0.0.1");
const adb = arg("--adb", "adb");
const serial = arg("--serial", "");
const packageName = arg("--package", "cyou.sharesrc.afk.release146");
const cacheRoot = path.resolve(arg("--cache-root", path.join(__dirname, "..", "runtime", "resource-cache")));
const extractedRoot = path.resolve(arg("--extracted-root", ""));
const timelyRoot = path.resolve(arg("--timely-root", ""));
const extraRoot = path.resolve(arg("--extra-root", ""));
const versionRoot = path.resolve(arg("--version-root", ""));
const apkPath = path.resolve(arg("--apk", ""));
const manifestPath = path.resolve(arg(
  "--manifest",
  path.join(__dirname, "..", "runtime", "official-updates", "1.201.01", "resource-manifests", "fileSizeCommon.json"),
));
const upstreamBase = arg("--upstream", "https://hgame-cdn.lilithgame.com/global/v2/").replace(/\/+$/, "") + "/";
const offline = process.argv.includes("--offline") || process.env.AFK_RESOURCE_OFFLINE === "1";
const noDevice = process.argv.includes("--no-device") || process.env.AFK_RESOURCE_NO_DEVICE === "1";
const deviceRoot = `/data/user/0/${packageName}`;

let expectedFiles = {};
if (manifestPath && fs.existsSync(manifestPath)) {
  try {
    expectedFiles = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    console.log(`Loaded ${Object.keys(expectedFiles).length} Classic resource checks from ${manifestPath}`);
  } catch (error) {
    console.error(`Could not load Classic resource manifest: ${error.message}`);
  }
}

function expectedFile(relative) {
  const normalized = relative.replaceAll("\\", "/").replace(/^rel\//, "");
  return expectedFiles[normalized] || null;
}

function validRollingCheckversion(file, relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (!/^(?:rel\/)?checkversionSplit\.zipe$/i.test(normalized)) return false;
  const listing = spawnSync("tar", ["-tf", file], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listing.status !== 0) return false;
  const entries = new Set(listing.stdout.split(/\r?\n/)
    .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter(Boolean));
  return entries.has("checkversion.md5")
    && entries.has("res/languageRes.jsone")
    && entries.has("res/splitRes.jsone")
    && entries.has("res/fileSizeCommon.jsone");
}

function verifiedFile(file, relative) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  // project.jsone is intentionally re-encrypted with the pinned 1.201 version
  // while retaining the current server/channel fields. Its official manifest
  // hash therefore cannot match by design.
  if (/^(?:rel\/)?project\.(?:json|jsone)$/i.test(relative.replaceAll("\\", "/"))) return true;
  // Lilith rolls this bootstrap archive in place without changing its URL, so
  // a pinned Classic manifest can legitimately contain the previous hash.
  // Accept only a readable archive with all mandatory bootstrap entries.
  if (validRollingCheckversion(file, relative)) return true;
  const expected = expectedFile(relative);
  if (!expected) return true;
  const bytes = fs.readFileSync(file);
  const actualMd5 = createHash("md5").update(bytes).digest("hex");
  const ok = bytes.length === Number(expected.size) && actualMd5 === String(expected.md5).toLowerCase();
  if (!ok) {
    console.log(`VERSION_REJECT ${relative} expected=${expected.size}/${expected.md5} actual=${bytes.length}/${actualMd5}`);
  }
  return ok;
}

let apkEntries = null;
if (apkPath && fs.existsSync(apkPath)) {
  const listing = spawnSync("tar", ["-tf", apkPath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listing.status === 0) {
    apkEntries = new Set(listing.stdout.split(/\r?\n/).filter(Boolean));
    console.log(`Indexed ${apkEntries.size} APK resources from ${apkPath}`);
  } else {
    console.error(`Could not index APK resources: ${listing.stderr.trim()}`);
  }
}

fs.mkdirSync(cacheRoot, { recursive: true });

function adbRun(args, options = {}) {
  const fullArgs = serial ? ["-s", serial, ...args] : args;
  return spawnSync(adb, fullArgs, { encoding: "utf8", windowsHide: true, ...options });
}

function normalizeRequestPath(urlValue) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlValue, "http://localhost").pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith("/global/v2/") || !/^[/A-Za-z0-9._-]+$/.test(pathname)) return null;
  const relative = pathname.slice("/global/v2/".length);
  if (relative.includes("..")) return null;
  return relative;
}

function localCandidates(relative) {
  const result = [path.join(cacheRoot, relative)];
  // Stage chapter archives generated from the recovered client assets are
  // stored under their stable logical name (for example
  // StageBattleChap4.zip).  The runtime manifest appends a short revision
  // token to that same name (StageBattleChap42859a.zip).  Treat the token as
  // an alias only for this tightly-scoped archive directory; applying this
  // heuristic to arbitrary resources could serve the wrong version.
  const chapterArchive = /^(rel\/res\/stageChapz\/(StageBattleChap\d+))([0-9a-f]{5})\.zip$/i.exec(
    relative.replaceAll("\\", "/"),
  );
  if (chapterArchive) {
    const alias = path.join(cacheRoot, `${chapterArchive[1]}.zip`);
    if (fs.existsSync(alias) && fs.statSync(alias).isFile()) {
      const actualRevision = createHash("md5").update(fs.readFileSync(alias)).digest("hex").slice(0, 5);
      if (actualRevision.toLowerCase() === chapterArchive[3].toLowerCase()) result.push(alias);
      else console.log(`ALIAS_REJECT ${relative} expected=${chapterArchive[3]} actual=${actualRevision}`);
    }
  }
  // The locally patched 1.201 client has supportEncrypt disabled and therefore
  // asks for plaintext project.json. The official CDN bootstrap is project.jsone;
  // synchronization keeps its verified plaintext projection beside it.
  const aliases = relative.toLowerCase() === "project.json" ? ["project.dec.current.json", "project.dec.json"] : [];
  if (versionRoot) {
    if (relative.startsWith("rel/")) result.push(path.join(versionRoot, relative.slice(4)));
    result.push(path.join(versionRoot, relative));
    for (const alias of aliases) result.push(path.join(versionRoot, alias));
  }
  if (extractedRoot) {
    if (relative.startsWith("rel/")) result.push(path.join(extractedRoot, relative.slice(4)));
    result.push(path.join(extractedRoot, relative));
  }
  if (timelyRoot) {
    if (relative.startsWith("rel/")) result.push(path.join(timelyRoot, relative.slice(4)));
    result.push(path.join(timelyRoot, relative));
  }
  if (extraRoot) {
    if (relative.startsWith("rel/")) result.push(path.join(extraRoot, relative.slice(4)));
    result.push(path.join(extraRoot, relative));
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTimelyArchive(relative) {
  if (!relative.toLowerCase().endsWith(".ppz")) return null;
  const rel = relative.startsWith("rel/") ? relative.slice(4) : relative;
  const archiveBase = path.basename(rel, path.extname(rel));
  const pattern = new RegExp(`^${escapeRegExp(archiveBase)}\\d+\\.(?:plist|pvr|pvr@alpha|png)$`, "i");
  let sourceDirectory = "", entries = [];
  for (const sourceRoot of [cacheRoot, extractedRoot, timelyRoot, extraRoot, versionRoot].filter(Boolean)) {
    const candidate = path.join(sourceRoot, path.dirname(rel));
    if (!fs.existsSync(candidate)) continue;
    const matches = fs.readdirSync(candidate).filter((entry) => pattern.test(entry)).sort();
    if (matches.length) { sourceDirectory = candidate; entries = matches; break; }
  }
  if (!sourceDirectory || !entries.length) return null;

  const destination = path.join(cacheRoot, relative);
  const temporary = `${destination}.${process.pid}.zip`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const packed = spawnSync("tar", ["-a", "-cf", temporary, ...entries], {
    cwd: sourceDirectory,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (packed.status !== 0 || !fs.existsSync(temporary)) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    return null;
  }
  fs.renameSync(temporary, destination);
  console.log(`TIMELY ${relative} <- ${entries.length} fragments`);
  return destination;
}

function buildFcaArchive(relative) {
  if (!/\.fca(?:p|s)z$/i.test(relative) || !/res\/fcaz(?:_lz)?\//i.test(relative)) return null;
  const rel = (relative.startsWith("rel/") ? relative.slice(4) : relative).replace(/res\/fcaz(?:_lz)?\//i, "res/fca/");
  const archiveBase = path.basename(rel, path.extname(rel));
  // Runtime manifests append a five-hex revision to FCA archives while the
  // extracted fragments keep their stable logical basename.
  const baseCandidates = [archiveBase];
  const revisionMatch = /^(.*?)([0-9a-f]{5})$/i.exec(archiveBase);
  if (revisionMatch && revisionMatch[1]) baseCandidates.push(revisionMatch[1]);
  for (const sourceRoot of [extractedRoot, timelyRoot, extraRoot, versionRoot].filter(Boolean)) {
    const fcaRoot = path.join(sourceRoot, "res", "fca"), sourceDirectory = path.join(sourceRoot, path.dirname(rel));
    if (!fs.existsSync(sourceDirectory) || !fs.existsSync(fcaRoot)) continue;
    const directoryEntries = fs.readdirSync(sourceDirectory);
    let entries = [];
    for (const base of baseCandidates) {
      const pattern = new RegExp(`^${escapeRegExp(base)}(?:\\d+)?\\.(?:atlas|skel|lzap|plist|pvr|pvr@alpha|png)$`, "i");
      entries = directoryEntries.filter((entry) => pattern.test(entry)).sort();
      if (entries.length) break;
    }
    // A plist-only archive is not a usable FCA bundle. It was the direct
    // cause of black Classic heroes: the client extracted metadata but still
    // lacked the matching lzap/texture and then rejected the generated ZIP by
    // the official 1.201 hash. Let the CDN supply the canonical archive.
    if (!entries.length || !entries.some((entry) => /\.(?:lzap|lzas|pvr|pvr@alpha|png)$/i.test(entry))) continue;
    const destination = path.join(cacheRoot, relative), temporary = `${destination}.${process.pid}.zip`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const archiveEntries = entries.map((entry) => path.relative(fcaRoot, path.join(sourceDirectory, entry)));
    const packed = spawnSync("tar", ["-a", "-cf", temporary, ...archiveEntries], { cwd: fcaRoot, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (packed.status === 0 && fs.existsSync(temporary)) { fs.renameSync(temporary, destination); console.log(`FCA ${relative} <- ${entries.length} fragments`); return destination; }
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return null;
}

function resolveDevicePath(relative) {
  if (relative === "rel/project.jsone") return `${deviceRoot}/native_cache/project.jsone`;
  if (relative === "mystical.jse") return `${deviceRoot}/native_cache/ApkFile/mystical.jse`;

  const rel = relative.startsWith("rel/") ? relative.slice(4) : relative;
  const versionRoot = `${deviceRoot}/files/1.145.01`;
  const installedCandidates = ["patch", "timely", "extra"].map(
    (directory) => `${versionRoot}/${directory}/${rel}`
  );
  const exactChecks = installedCandidates.map((candidate, index) =>
    `${index ? "elif" : "if"} [ -f ${candidate} ]; then printf '%s' ${candidate};`
  );
  const command = [
    ...exactChecks,
    `else find ${versionRoot} ${deviceRoot}/native_cache/global/v2/patches_new`,
    `-type f -path '*/${rel}' 2>/dev/null | tail -n 1; fi`,
  ].join(" ");
  const result = adbRun(["shell", `su -c "${command}"`]);
  return result.status === 0 ? result.stdout.trim() : "";
}

function fetchFromDevice(relative) {
  const source = resolveDevicePath(relative);
  if (!source) return null;
  const destination = path.join(cacheRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `/sdcard/afk_resource_${process.pid}_${Date.now()}`;
  const copied = adbRun(["shell", `su -c "cp ${source} ${temporary} && chmod 644 ${temporary}"`]);
  if (copied.status !== 0) return null;
  const pulled = adbRun(["pull", temporary, destination]);
  adbRun(["shell", "rm", "-f", temporary]);
  return pulled.status === 0 && fs.existsSync(destination) ? destination : null;
}

function resolveApkEntry(relative) {
  if (!apkEntries) return "";
  const rel = relative.startsWith("rel/") ? relative.slice(4) : relative;
  const candidates = [`assets/${rel}`, `assets/${relative}`];
  return candidates.find((candidate) => apkEntries.has(candidate)) || "";
}

function fetchFromApk(relative) {
  const entry = resolveApkEntry(relative);
  if (!entry) return null;
  const extracted = spawnSync("tar", ["-xOf", apkPath, entry], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (extracted.status !== 0 || !extracted.stdout?.length) return null;
  const destination = path.join(cacheRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, extracted.stdout);
  console.log(`APK ${relative} <- ${entry}`);
  return destination;
}

async function fetchFromOfficialCdn(relative, destinationRelative = relative) {
  const target = new URL(relative, upstreamBase);
  if (target.origin !== new URL(upstreamBase).origin) return null;
  try {
    const result = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!result.ok) return null;
    const declared = Number(result.headers.get("content-length") || 0);
    if (declared > 128 * 1024 * 1024) return null;
    const bytes = Buffer.from(await result.arrayBuffer());
    if (!bytes.length || bytes.length > 128 * 1024 * 1024) return null;
    const destination = path.join(cacheRoot, destinationRelative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.download`;
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, destination);
    console.log(`UPSTREAM ${relative} ${bytes.length}`);
    return destination;
  } catch (error) {
    console.error(`UPSTREAM_ERROR ${relative} ${error.message}`);
    return null;
  }
}

async function fetchLogicalFcaFromOfficialCdn(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const match = /^(.*?)([0-9a-f]{5})\.fca(?:p|s|t)z$/i.exec(normalized);
  if (!match) return null;
  // Old Classic manifests request GPU-specific .fcasz files carrying a
  // revision suffix. The live CDN retains the logical, universal PNG archive
  // without that suffix, which is safe for every renderer used by this build.
  const logical = `${match[1]}.fcapz`;
  const file = await fetchFromOfficialCdn(logical, relative);
  if (file) console.log(`UPSTREAM_FCA_FALLBACK ${relative} <- ${logical}`);
  return file;
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json" })[ext]
    || "application/octet-stream";
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return false;
    if (start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  const relative = normalizeRequestPath(request.url);
  if (!relative) {
    response.writeHead(400).end();
    return;
  }
  let file = localCandidates(relative).find((candidate) => verifiedFile(candidate, relative));
  if (!file) {
    const candidate = buildTimelyArchive(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file) {
    const candidate = buildFcaArchive(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file && !noDevice) {
    const candidate = fetchFromDevice(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file) {
    const candidate = fetchFromApk(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file && !offline) {
    const candidate = await fetchFromOfficialCdn(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file && !offline) {
    const candidate = await fetchLogicalFcaFromOfficialCdn(relative);
    if (verifiedFile(candidate, relative)) file = candidate;
  }
  if (!file) {
    console.log(`MISS ${relative}`);
    response.writeHead(404).end();
    return;
  }
  const stat = fs.statSync(file);
  const requestedRange = request.headers.range;
  const range = parseByteRange(requestedRange, stat.size);
  const commonHeaders = {
    "Content-Type": contentType(file),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  if (range === false) {
    response.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${stat.size}` }).end();
    console.log(`RANGE_INVALID ${relative} ${requestedRange || ""} size=${stat.size} remote=${request.socket.remoteAddress || ""}`);
    return;
  }
  const status = range ? 206 : 200;
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  const headers = { ...commonHeaders, "Content-Length": Math.max(0, end - start + 1) };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(file, range ? { start, end } : undefined).pipe(response);
  console.log(`HIT ${relative} status=${status} bytes=${start}-${end}/${stat.size} remote=${request.socket.remoteAddress || ""}`);
});

server.listen(port, host, () => console.log(`AFK resource cache listening on ${host}:${port} (${offline ? "strict offline" : `upstream ${upstreamBase}`}, device ${noDevice ? "disabled" : "enabled"})`));
