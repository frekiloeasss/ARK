"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { X509Certificate, createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "runtime");
const checks = [];
function check(name, ok, details = {}) { checks.push({ name, ok: Boolean(ok), ...details }); }
function json(name) { return JSON.parse(fs.readFileSync(path.join(runtime, name), "utf8").replace(/^\uFEFF/, "")); }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function checksum(file) { const hash=createHash("sha256");hash.update(fs.readFileSync(file));return hash.digest("hex"); }

async function main() {
  const coverage = json("protocol-coverage.json");
  check("protocol_closure", coverage.summary.unimplemented === 0 && coverage.summary.stateful_generic === 0, coverage.summary);
  const schema = json("protobuf-schema.json");
  check("protobuf_schema", schema.message_count >= 2500 && schema.enum_count >= 180, { message_count: schema.message_count, enum_count: schema.enum_count });
  const manifest = json("resource-manifest-1.145.01.json");
  check("offline_resource_manifest", manifest.file_count >= 47000 && manifest.total_bytes >= 3_700_000_000, { file_count: manifest.file_count, total_bytes: manifest.total_bytes, sha256: manifest.sha256, root_exists: fs.existsSync(manifest.root) });
  const secretsPath = path.join(runtime, "private-server-secrets.json");
  if (fs.existsSync(secretsPath)) {
    const secrets = json("private-server-secrets.json");
    check("deployment_secrets", String(secrets.admin_password || "").length >= 32 && String(secrets.payment_secret || "").length >= 32 && secrets.admin_password !== "afk-admin-local");
  } else check("deployment_secrets", false, { error: "deploy_private_server_once_to_generate" });
  const certPath = path.join(runtime, "tls", "mock-cert.pem");
  if (fs.existsSync(certPath)) {
    const cert = new X509Certificate(fs.readFileSync(certPath));
    check("tls_certificate", new Date(cert.validTo).getTime() > Date.now() + 7 * 86400000, { valid_to: cert.validTo, fingerprint256: cert.fingerprint256 });
  } else check("tls_certificate", false, { error: "certificate_missing" });
  const stackPath = path.join(runtime, "stack.json");
  let stack = null;
  if (fs.existsSync(stackPath)) {
    stack = json("stack.json");
    const services = Object.fromEntries(["mock_pid", "ws_pid", "resource_pid", "proxy_pid", "mysql_pid", "instant_pay_bridge_pid"].map((key) => [key, alive(stack[key])]));
    check("runtime_processes", Object.values(services).every(Boolean), services);
  } else check("runtime_processes", false, { error: "stack_state_missing" });
  const latestProtocolRoot = path.join(runtime, "official-updates", "1.201.01", "protocol");
  const latestRoutePath = path.join(latestProtocolRoot, "protocol-route-map.json");
  const latestSchemaPath = path.join(latestProtocolRoot, "protobuf-schema.json");
  if (stack && fs.existsSync(latestRoutePath) && fs.existsSync(latestSchemaPath)) {
    const latestRoutes = JSON.parse(fs.readFileSync(latestRoutePath, "utf8"));
    const latestSchema = JSON.parse(fs.readFileSync(latestSchemaPath, "utf8"));
    check(
      "latest_client_migration",
      stack.client_track === "1.201" && stack.client_package === "com.lilithgame.hgame.gp" &&
        String(stack.client_version).startsWith("1.201.01") && latestRoutes.module_count >= 222 &&
        latestSchema.message_count >= 3266 && latestSchema.enum_count >= 239,
      {
        client_track: stack.client_track,
        client_package: stack.client_package,
        client_version: stack.client_version,
        protocol_modules: latestRoutes.module_count,
        protobuf_messages: latestSchema.message_count,
        protobuf_enums: latestSchema.enum_count,
      }
    );
  } else check("latest_client_migration", false, { error: "latest_client_protocol_artifacts_missing" });
  const deviceCoveragePath = path.join(runtime, "device-coverage.json");
  if (fs.existsSync(deviceCoveragePath)) {
    const deviceCoverage = json("device-coverage.json");
    const byModule = Object.fromEntries((deviceCoverage.modules || []).map((entry) => [entry.module, entry]));
    const requiredModules = ["sdk_login", "login", "heartbeat"];
    check(
      "latest_device_regression",
      deviceCoverage.client_version === "1.201.01.360409" &&
        Number(deviceCoverage.summary?.module_count) === 178 &&
        Number(deviceCoverage.evidence?.device_run_count) >= 1 &&
        Number(deviceCoverage.summary?.failed) === 0 &&
        requiredModules.every((name) => ["ui_pass", "db_pass", "idempotent_pass", "reconnect_pass"].includes(byModule[name]?.status)),
      {
        client_version: deviceCoverage.client_version,
        device_run_count: deviceCoverage.evidence?.device_run_count,
        summary: deviceCoverage.summary,
        required_modules: Object.fromEntries(requiredModules.map((name) => [name, byModule[name]?.status || "missing"])),
      }
    );
  } else check("latest_device_regression", false, { error: "device_coverage_missing" });
  const devicePidPath = path.join(runtime, "device-regression.pid");
  const devicePid = fs.existsSync(devicePidPath) ? Number(fs.readFileSync(devicePidPath, "utf8").trim()) : 0;
  check("continuous_device_regression", devicePid > 0 && alive(devicePid), { pid: devicePid || null });
  try {
    const response = await fetch("http://127.0.0.1:18080/__afk/health", { signal: AbortSignal.timeout(5000) });
    const health = await response.json();
    check("service_health", response.ok && health.ok && health.db?.ready, health);
  } catch (error) { check("service_health", false, { error: error.message }); }
  try {
    const response = await fetch("http://127.0.0.1:18080/__afk/bots/status", { signal: AbortSignal.timeout(5000) });
    const ecosystem = await response.json();
    check(
      "bot_ecosystem",
      response.ok && ecosystem.ok && Number(ecosystem.bot_count) >= 120 && Number(ecosystem.guild_count) >= 6,
      ecosystem
    );
  } catch (error) { check("bot_ecosystem", false, { error: error.message }); }
  const latestSyncPath = path.join(runtime, "official-updates", "1.201.01", "sync-result.json");
  const latestInspectionPath = path.join(runtime, "official-updates", "1.201.01", "inspection.json");
  if (fs.existsSync(latestSyncPath) && fs.existsSync(latestInspectionPath)) {
    const latestSync = JSON.parse(fs.readFileSync(latestSyncPath, "utf8").replace(/^\uFEFF/, ""));
    const latestInspection = JSON.parse(fs.readFileSync(latestInspectionPath, "utf8").replace(/^\uFEFF/, ""));
    check(
      "latest_official_resources",
      latestInspection.ok === true && latestInspection.package === "com.lilithgame.hgame.gp" &&
        latestInspection.version_name === latestSync.version && Number(latestSync.asset_file_count) >= 23000 &&
        Number(latestSync.decrypted_config_count) >= 5930 && Number(latestSync.decrypted_config_failures) === 0 &&
        fs.existsSync(latestSync.xapk) && fs.existsSync(latestSync.assets_root) && fs.existsSync(latestSync.decrypted_config_root),
      {
        version: latestSync.version,
        package: latestInspection.package,
        version_code: latestInspection.version_code,
        certificate_sha1: latestInspection.certificate_sha1,
        asset_file_count: latestSync.asset_file_count,
        decrypted_config_count: latestSync.decrypted_config_count,
        decrypted_config_failures: latestSync.decrypted_config_failures,
        activated: latestSync.activated,
      }
    );
  } else check("latest_official_resources", false, { error: "latest_resource_evidence_missing" });
  const backupRoots = [path.join(runtime, "backups"), path.join(runtime, "offsite-backups")];
  for (const backupRoot of backupRoots) {
    const sqlFiles = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot).filter((name) => name.endsWith(".sql")).sort().reverse() : [];
    const file = sqlFiles[0] ? path.join(backupRoot, sqlFiles[0]) : null;
    const sidecar = file ? `${file}.sha256` : null;
    const expected = sidecar && fs.existsSync(sidecar) ? fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0].toLowerCase() : "";
    check(path.basename(backupRoot) === "backups" ? "local_backup" : "offsite_backup", Boolean(file && expected && checksum(file) === expected), { file, sidecar: Boolean(expected) });
  }
  const report = { format: "afk-production-readiness-v1", generated_at: new Date().toISOString(), ok: checks.every((entry) => entry.ok), passed: checks.filter((entry) => entry.ok).length, total: checks.length, checks };
  fs.writeFileSync(path.join(runtime, "production-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
main();
