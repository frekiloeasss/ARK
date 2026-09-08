const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function arg(name, fallback) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; }
const root = path.resolve(arg("root", path.join(__dirname, "..")));
const clientTrack = arg("client-track", "1.201");
const publicHost = arg("public-host", "198.18.0.1");
const runtime = path.join(root, "runtime");
const healthPath = path.join(runtime, "ops-health.json");
const historyPath = path.join(runtime, "ops-health.jsonl");
const alertsPath = path.join(runtime, "ops-alerts.jsonl");
let lastRestart = 0;
let lastBackupDay = "";
let lastAlertState = "";

function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
async function inspect() {
  let stack = {};
  try { stack = JSON.parse(fs.readFileSync(path.join(runtime, "stack.json"), "utf8").replace(/^\uFEFF/, "")); } catch {}
  const services = Object.fromEntries(["mock_pid","ws_pid","resource_pid","proxy_pid","mysql_pid","instant_pay_bridge_pid"].map((key) => [key, { pid: Number(stack[key] || 0), alive: alive(stack[key]) }]));
  let health = null;
  try { const response = await fetch("http://127.0.0.1:18080/__afk/health", { signal: AbortSignal.timeout(5000) }); health = await response.json(); } catch (error) { health = { ok: false, error: error.message }; }
  const record = { ts: new Date().toISOString(), ok: Boolean(health?.ok && health?.db?.ready && Object.values(services).every((row) => row.alive)), health, services };
  fs.writeFileSync(`${healthPath}.tmp`, JSON.stringify(record, null, 2));
  fs.renameSync(`${healthPath}.tmp`, healthPath);
  fs.appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
  const alertState = record.ok ? "healthy" : "unhealthy";
  if (alertState !== lastAlertState) {
    lastAlertState = alertState;
    const alert = { ts: record.ts, severity: record.ok ? "info" : "critical", event: `stack_${alertState}`, services, health };
    fs.appendFileSync(alertsPath, `${JSON.stringify(alert)}\n`);
    if (process.env.AFK_ALERT_WEBHOOK) fetch(process.env.AFK_ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alert), signal: AbortSignal.timeout(5000) }).catch(()=>{});
  }
  const day = record.ts.slice(0, 10);
  if (record.ok && day !== lastBackupDay) {
    lastBackupDay = day;
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "backup-private-server.ps1"), "-Label", "daily"], { cwd: root, windowsHide: true, detached: true, stdio: "ignore" }).unref();
  }
  if (!record.ok && Date.now() - lastRestart > 120000) {
    lastRestart = Date.now();
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "deploy-private-server.ps1"), "-ClientTrack", clientTrack, "-PublicHost", publicHost, "-NoSupervisor"], { cwd: root, windowsHide: true, detached: true, stdio: "ignore" }).unref();
  }
}
inspect();
setInterval(inspect, 30000);
