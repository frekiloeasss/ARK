const fs = require("node:fs");

const DEFAULT_NEEDLES = [
  "platform_coin",
  "platform-currency",
  "平台币",
  "diamond_charge",
  "vip_exp",
  "charge",
  "currency",
  "coin",
  "wallet",
  "balance",
  "purchase",
  "order",
  "pay",
];

function readJsonlTail(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function includesAnyNeedle(value, needles) {
  const text = typeof value === "string" ? value : JSON.stringify(value || "");
  const lowerText = text.toLowerCase();
  return needles.some((needle) => lowerText.includes(needle));
}

function compactMonitorRecord(record, source) {
  if (source === "ws") {
    return {
      source,
      time: record.ts || record.time || null,
      session_id: record.session_id ?? null,
      direction: record.direction || null,
      event: record.event || null,
      request_kind: record.request_kind || record.request_signature?.kind || null,
      request_seq: record.request_seq || record.request_signature?.seq || null,
      fixture_label: record.fixture_label || null,
      message_type: record.message_type || null,
      size: record.size || null,
      route: record.route || null,
    };
  }
  return {
    source,
    time: record.time || null,
    request_id: record.request_id || null,
    method: record.method || null,
    local_path: record.local_path || null,
    local_query: record.local_query || "",
    original_host: record.original_host || null,
    action: record.action || null,
    upstream_url: record.upstream_url || null,
    status_code: record.status_code ?? null,
    duration_ms: record.duration_ms ?? null,
  };
}

function buildPlatformCurrencyMonitor(query, { requestLog, wsFrameLog }) {
  const limit = Math.max(1, Math.min(Number(query.get("limit") || "50"), 500));
  const scan = Math.max(limit, Math.min(Number(query.get("scan") || "2000"), 20000));
  const extraNeedles = String(query.get("q") || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const needles = Array.from(new Set(DEFAULT_NEEDLES.concat(extraNeedles)));

  const requestMatches = readJsonlTail(requestLog, scan)
    .filter((record) =>
      includesAnyNeedle(
        [
          record.local_path,
          record.local_query,
          record.original_host,
          record.upstream_url,
          record.request_body_preview,
          record.response_body_preview,
        ],
        needles
      )
    )
    .map((record) => compactMonitorRecord(record, "http"));

  const wsMatches = readJsonlTail(wsFrameLog, scan)
    .filter(
      (record) =>
        record.request_kind === "charge" ||
        record.request_signature?.kind === "charge" ||
        includesAnyNeedle(record, needles)
    )
    .map((record) => compactMonitorRecord(record, "ws"));

  const events = requestMatches
    .concat(wsMatches)
    .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")))
    .slice(0, limit);
  const countsBySource = events.reduce((counts, event) => {
    counts[event.source] = (counts[event.source] || 0) + 1;
    return counts;
  }, {});

  return {
    ok: true,
    monitor: "platform-currency",
    note: "Matches are heuristic: HTTP request/response previews plus websocket charge/currency-like frames.",
    files: { requests: requestLog, websocket_frames: wsFrameLog },
    query: { limit, scan, needles },
    counts: { returned: events.length, by_source: countsBySource },
    events,
  };
}

module.exports = { buildPlatformCurrencyMonitor };
