const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const candidates = [
  process.env.PYTHON,
  process.env.PYTHON_EXE,
  process.env.CODEX_PYTHON,
];

if (process.platform === "win32") {
  candidates.push(
    "D:\\study\\ShadowBot\\shadowbot-6.0.30\\python310\\python.exe",
    path.join(
      process.env.USERPROFILE || "",
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      "python.exe"
    ),
    "python",
    "py"
  );
} else {
  candidates.push("python3", "python");
}

let result = null;
for (const command of candidates) {
  if (!command) {
    continue;
  }
  if (path.isAbsolute(command) && !fs.existsSync(command)) {
    continue;
  }

  result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  if (result.error && result.error.code === "ENOENT") {
    continue;
  }

  process.exit(result.status ?? 1);
}

console.error("Python launcher not found. Tried: " + candidates.filter(Boolean).join(", "));
process.exit(1);
