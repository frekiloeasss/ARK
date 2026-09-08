const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("resource server startup timed out")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("AFK resource cache listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`resource server exited: ${code}`)));
  });
}

test("rebuilds a requested ppz from timely plist/pvr fragments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-resource-test-"));
  const timely = path.join(root, "timely", "res", "ui", "plist");
  const cache = path.join(root, "cache");
  fs.mkdirSync(timely, { recursive: true });
  fs.writeFileSync(path.join(timely, "sample0.plist"), "plist-data");
  fs.writeFileSync(path.join(timely, "sample0.pvr"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(timely, "sample0.pvr@alpha"), Buffer.from([5, 6, 7, 8]));

  const port = await reservePort();
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "resource-cache-server.js"),
      "--port", String(port),
      "--adb", path.join(root, "missing-adb"),
      "--cache-root", cache,
      "--timely-root", path.join(root, "timely"),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  try {
    await waitForListening(child);
    const response = await fetch(
      `http://127.0.0.1:${port}/global/v2/rel/res/ui/plist/sample.ppz`
    );
    assert.equal(response.status, 200);
    const payload = Buffer.from(await response.arrayBuffer());
    assert.equal(payload.subarray(0, 2).toString("ascii"), "PK");
    const archive = path.join(cache, "rel", "res", "ui", "plist", "sample.ppz");
    const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0);
    assert.match(listing.stdout, /sample0\.plist/);
    assert.match(listing.stdout, /sample0\.pvr@alpha/);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strict offline mode returns a local miss without contacting an upstream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-resource-offline-test-"));
  const port = await reservePort();
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "resource-cache-server.js"),
    "--port", String(port), "--cache-root", path.join(root, "cache"),
    "--offline", "--no-device",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await waitForListening(child);
    const response = await fetch(`http://127.0.0.1:${port}/global/v2/rel/definitely-missing.bin`);
    assert.equal(response.status, 404);
  } finally {
    child.kill("SIGTERM"); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serves a structurally valid rolling checkversion archive despite a stale pinned hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-checkversion-test-"));
  const source = path.join(root, "source");
  const cache = path.join(root, "cache");
  const archive = path.join(cache, "rel", "checkversionSplit.zipe");
  const manifest = path.join(root, "manifest.json");
  for (const relative of ["checkversion.md5", "res/languageRes.jsone", "res/splitRes.jsone", "res/fileSizeCommon.jsone"]) {
    const file = path.join(source, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const packed = spawnSync("tar", ["-a", "-cf", archive, "-C", source, "."], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  fs.writeFileSync(manifest, JSON.stringify({ "checkversionSplit.zipe": { size: 1, md5: "00000000000000000000000000000000" } }));
  const port = await reservePort();
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "resource-cache-server.js"),
    "--port", String(port), "--cache-root", cache, "--manifest", manifest, "--offline", "--no-device",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await waitForListening(child);
    const response = await fetch(`http://127.0.0.1:${port}/global/v2/rel/checkversionSplit.zipe`);
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get("content-length")), fs.statSync(archive).size);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses a stable stage chapter archive only when its MD5 revision matches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-resource-chapter-test-"));
  const cache = path.join(root, "cache");
  const stable = path.join(cache, "rel", "res", "stageChapz", "StageBattleChap4.zip");
  const payload = Buffer.from("verified-stage-chapter", "utf8");
  const revision = createHash("md5").update(payload).digest("hex").slice(0, 5);
  fs.mkdirSync(path.dirname(stable), { recursive: true });
  fs.writeFileSync(stable, payload);
  const port = await reservePort();
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "resource-cache-server.js"),
    "--port", String(port), "--cache-root", cache, "--offline", "--no-device",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await waitForListening(child);
    const matching = await fetch(
      `http://127.0.0.1:${port}/global/v2/rel/res/stageChapz/StageBattleChap4${revision}.zip`
    );
    assert.equal(matching.status, 200);
    assert.deepEqual(Buffer.from(await matching.arrayBuffer()), payload);

    const mismatching = await fetch(
      `http://127.0.0.1:${port}/global/v2/rel/res/stageChapz/StageBattleChap400000.zip`
    );
    assert.equal(mismatching.status, 404);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serves resumable byte ranges for partially downloaded game resources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-resource-range-test-"));
  const cache = path.join(root, "cache");
  const resource = path.join(cache, "rel", "srcmodule", "csvtable_cn_P7d20a.zipe");
  fs.mkdirSync(path.dirname(resource), { recursive: true });
  fs.writeFileSync(resource, Buffer.from("0123456789", "ascii"));
  const port = await reservePort();
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "resource-cache-server.js"),
    "--port", String(port), "--cache-root", cache, "--offline", "--no-device",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  try {
    await waitForListening(child);
    const response = await fetch(
      `http://127.0.0.1:${port}/global/v2/rel/srcmodule/csvtable_cn_P7d20a.zipe`,
      { headers: { Range: "bytes=3-6" } }
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(await response.text(), "3456");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebuilds hashed fcasz and legacy fcapz archives from extracted fca fragments", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"afk-fca-test-")),fca=path.join(root,"patch","res","fca","effect"),cache=path.join(root,"cache");fs.mkdirSync(fca,{recursive:true});
  fs.writeFileSync(path.join(fca,"demo0.plist"),"plist");fs.writeFileSync(path.join(fca,"demo0.lzap"),Buffer.from([1,2,3]));
  const port=await reservePort(),child=spawn(process.execPath,[path.join(__dirname,"..","scripts","resource-cache-server.js"),"--port",String(port),"--cache-root",cache,"--extracted-root",path.join(root,"patch"),"--offline","--no-device"],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  try{
    await waitForListening(child);
    for (const archive of ["demoa1b2c.fcasz", "demo.fcapz"]) {
      const response=await fetch(`http://127.0.0.1:${port}/global/v2/rel/res/fcaz_lz/effect/${archive}`);
      assert.equal(response.status,200);
      const file=path.join(cache,"rel","res","fcaz_lz","effect",archive),listing=spawnSync("tar",["-tf",file],{encoding:"utf8"});
      assert.equal(listing.status,0);
      assert.match(listing.stdout,/effect[\\/]demo0\.lzap/);
    }
  }finally{child.kill("SIGTERM");fs.rmSync(root,{recursive:true,force:true})}
});

test("falls back from a hashed Classic fcasz request to the CDN logical fcapz", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"afk-fca-upstream-test-")),cache=path.join(root,"cache");
  const upstreamPort=await reservePort(),resourcePort=await reservePort(),payload=Buffer.from("logical-fcapz");
  const upstream=http.createServer((request,response)=>{
    if(request.url==="/global/v2/rel/res/fcaz/effect/demo.fcapz"){
      response.writeHead(200,{"content-length":payload.length});response.end(payload);return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>upstream.listen(upstreamPort,"127.0.0.1",resolve).once("error",reject));
  const child=spawn(process.execPath,[path.join(__dirname,"..","scripts","resource-cache-server.js"),"--port",String(resourcePort),"--cache-root",cache,"--upstream",`http://127.0.0.1:${upstreamPort}/global/v2/`,"--no-device"],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  try{
    await waitForListening(child);
    const response=await fetch(`http://127.0.0.1:${resourcePort}/global/v2/rel/res/fcaz/effect/demoa1b2c.fcasz`);
    assert.equal(response.status,200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(),payload.toString());
    assert.equal(fs.readFileSync(path.join(cache,"rel","res","fcaz","effect","demoa1b2c.fcasz")).toString(),payload.toString());
  }finally{
    child.kill("SIGTERM");
    await new Promise((resolve)=>upstream.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
