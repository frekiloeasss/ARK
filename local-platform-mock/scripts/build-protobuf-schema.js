const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const protoRoot = path.resolve(arg("--proto-root", path.join(root, "data", "proto")));
const outputPath = path.resolve(arg("--output", path.join(root, "runtime", "protobuf-schema.json")));
const clientVersion = arg("--client-version", "1.182.03.301371");

function blocks(source, keyword) {
  const output = [];
  const pattern = new RegExp(`\\b${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\{`, "g");
  for (const match of source.matchAll(pattern)) {
    let depth = 0;
    for (let index = source.indexOf("{", match.index); index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}" && --depth === 0) {
        output.push({ name: match[1], body: source.slice(source.indexOf("{", match.index) + 1, index) });
        break;
      }
    }
  }
  return output;
}

function stripComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); }

const messages = {};
const enums = {};
for (const file of ["common.proto", "down.proto", "up.proto"]) {
  const source = stripComments(fs.readFileSync(path.join(protoRoot, file), "utf8"));
  for (const block of blocks(source, "enum")) {
    const values = {};
    for (const match of block.body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)/gm)) values[match[1]] = Number(match[2]);
    enums[block.name] = values;
  }
  for (const block of blocks(source, "message")) {
    const fields = [];
    for (const match of block.body.matchAll(/^\s*(optional|required|repeated)\s+([A-Za-z_][A-Za-z0-9_.]*|map\s*<[^>]+>)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)(?:\s*\[([^\]]+)\])?\s*;/gm)) {
      const options = match[5] || "";
      const defaultMatch = /default\s*=\s*([^,\s]+)/.exec(options);
      fields.push({ label: match[1], type: match[2].replace(/\s+/g, ""), name: match[3], number: Number(match[4]), default: defaultMatch?.[1] ?? null });
    }
    messages[block.name] = { fields };
  }
}

const output = { version: 1, client_version: clientVersion, generated_at: new Date().toISOString(), message_count: Object.keys(messages).length, enum_count: Object.keys(enums).length, messages, enums };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ message_count: output.message_count, enum_count: output.enum_count }));
