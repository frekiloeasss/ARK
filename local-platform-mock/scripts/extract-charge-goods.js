const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = path.resolve(
  process.argv[2] || path.join(ROOT, "..", "artifacts", "afkdragon", "runtime", "login_hit_probes", "login_probe_e", "logcat.txt")
);
const output = path.resolve(process.argv[3] || path.join(ROOT, "data", "official", "charge-goods-recovered.json"));
const rows = {};
const sourceBytes = fs.readFileSync(source);
const sourceText = sourceBytes[0] === 0xff && sourceBytes[1] === 0xfe
  ? sourceBytes.subarray(2).toString("utf16le")
  : sourceBytes.toString("utf8").replace(/^\uFEFF/, "");

for (const line of sourceText.split(/\r?\n/)) {
  const match = line.match(/JS:\s+\["(\d+)"\]\s+(\{.*\})\s*$/);
  if (!match) continue;
  try {
    const row = JSON.parse(match[2]);
    if (Number(row.ID) !== Number(match[1]) || !Number.isFinite(Number(row.ChargeID)) || !Array.isArray(row.Rewards)) continue;
    rows[String(row.ID)] = row;
  } catch {}
}

const ordered = Object.fromEntries(Object.keys(rows).sort((a, b) => Number(a) - Number(b)).map((key) => [key, rows[key]]));
if (!Object.keys(ordered).length) throw new Error(`No ChargeGoods rows recovered from ${source}`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
  format: "afk-charge-goods-recovered-v1",
  client_version: "1.182.03.301371",
  source: path.relative(ROOT, source).replaceAll("\\", "/"),
  count: Object.keys(ordered).length,
  rows: ordered,
}, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, output, count: Object.keys(ordered).length }));
