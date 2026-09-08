const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("./official-config-catalog");

const chargeGoodsPath = path.resolve(__dirname, "..", "data", "official", "charge-goods-recovered.json");
const chargeGoods = fs.existsSync(chargeGoodsPath)
  ? JSON.parse(fs.readFileSync(chargeGoodsPath, "utf8").replace(/^\uFEFF/, "")).rows || {}
  : {};

function secret() { return process.env.AFK_PAYMENT_SECRET || "afk-local-sandbox-only-change-me"; }
function signature(orderId, status = "paid") { return createHmac("sha256", secret()).update(`${orderId}:${status}`).digest("hex"); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function chargeTable() { return loadConfig("Charge").table; }
function findSku(sku) {
  const key = String(sku || "");
  const direct = chargeTable()[key];
  if (direct) return direct;
  return Object.values(chargeTable()).find((row) => String(row.ID) === key || (row.ProductIDs || []).map(String).includes(key)) || null;
}

function tokenAssets(tokens) {
  const assets = [];
  for (let i = 0; i + 2 < (tokens || []).length; i += 3) {
    const [type, id, amount] = tokens.slice(i, i + 3);
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) continue;
    const normalizedType = String(type).toLowerCase();
    const normalizedId = normalizedType === "currency" ? String(id).toLowerCase() : String(id);
    assets.push({ type: normalizedType, id: normalizedId, item_id: normalizedType === "currency" ? normalizedId : `${normalizedType}_${normalizedId}`, amount: Number(amount) });
  }
  return Object.values(assets.reduce((merged, asset) => {
    const key = `${asset.type}:${asset.id}`;
    merged[key] = merged[key] ? { ...asset, amount: merged[key].amount + asset.amount } : asset;
    return merged;
  }, {}));
}

function goodsInfo(goodsId) {
  const row = chargeGoods[String(goodsId || "")];
  if (!row) return null;
  return {
    goods_id: String(row.ID), charge_id: String(row.ChargeID), title: row.DisplayName || `Goods ${row.ID}`,
    description: row.Description || "", rewards: tokenAssets(row.Rewards), daily_rewards: tokenAssets(row.DailyRewards),
    limit: Number(row.Limit || 0), type: row.Type || "", official_config: "ChargeGoods", official_row: row,
  };
}

function skuInfo(sku) {
  const row = findSku(sku);
  if (!row) return null;
  const priceMinor = Math.max(0, Math.trunc(Number(row.CHNCost ?? row.Cost ?? 0)));
  const rewards = [...tokenAssets(row.BBB), ...tokenAssets(row.PaidBBB), ...tokenAssets(row.ExtraBBB)];
  return { sku: String(row.ID), title: row.CHNDisplayTitle || row.DisplayName || `SKU ${row.ID}`, description: row.CHNDisplayDescription || "",
    amount_minor: priceMinor, currency: "CNY", rewards, official_config: "Charge", official_row: row };
}

function purchaseInfo(sku, goodsId) {
  const goods = goodsInfo(goodsId);
  const product = skuInfo(sku || goods?.charge_id);
  if (!product) return null;
  return goods ? { ...product, goods_id: goods.goods_id, title: goods.title, description: goods.description, rewards: goods.rewards, goods } : product;
}

async function createOrder(pool, playerId, request = {}) {
  const product = purchaseInfo(request.sku || request.product_id, request.goods_id);
  if (!product) return { ok: false, http_status: 404, error: "charge_sku_not_found" };
  const idempotencyKey = String(request.idempotency_key || randomUUID()).slice(0, 191);
  const [existing] = await pool.execute("SELECT * FROM payment_orders WHERE idempotency_key=? LIMIT 1", [idempotencyKey]);
  if (existing.length) return { ok: true, order: existing[0], idempotent_replay: true, sandbox: true };
  const id = randomUUID();
  await pool.execute("INSERT INTO payment_orders (id,player_id,sku,amount_minor,currency,idempotency_key,request_json) VALUES (?,?,?,?,?,?,?)",
    [id, playerId, product.sku, product.amount_minor, product.currency, idempotencyKey, JSON.stringify({ source: "local_instant_grant", requested_sku: request.sku || request.product_id || product.sku, goods_id: product.goods_id || null })]);
  return { ok: true, order: { id, player_id: playerId, ...product, status: "created", provider: "sandbox", idempotency_key: idempotencyKey },
    confirmation: { status: "paid", signature: signature(id) }, sandbox: true,
    instant_grant: true, warning: "Local instant-grant mode. No real money is collected and no official receipt is generated.", evidence_level: "official_charge_catalog_local_instant_fulfillment" };
}

async function confirmOrder(pool, orderId, providedSignature) {
  if (!safeEqual(signature(orderId), providedSignature)) return { ok: false, http_status: 401, error: "invalid_sandbox_signature" };
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [orders] = await connection.execute("SELECT * FROM payment_orders WHERE id=? FOR UPDATE", [orderId]);
    if (!orders.length) { await connection.rollback(); return { ok: false, http_status: 404, error: "payment_order_not_found" }; }
    const order = orders[0];
    if (order.status === "fulfilled") { await connection.commit(); return { ok: true, order, idempotent_replay: true, sandbox: true }; }
    if (!['created','paid'].includes(order.status)) { await connection.rollback(); return { ok: false, http_status: 409, error: "payment_order_not_fulfillable", order_status: order.status }; }
    let requestJson = order.request_json || {};
    if (typeof requestJson === "string") { try { requestJson = JSON.parse(requestJson); } catch { requestJson = {}; } }
    const product = purchaseInfo(order.sku, requestJson.goods_id);
    if (!product) { await connection.rollback(); return { ok: false, http_status: 409, error: "charge_sku_removed" }; }
    for (const reward of product.rewards) {
      if (reward.type === "hero") {
        const characterId = `payment:${order.id}:${reward.id}`;
        await connection.execute("INSERT IGNORE INTO characters (player_id,character_id,level,star,extra_json) VALUES (?,?,?,?,?)",
          [order.player_id, characterId, 1, 1, JSON.stringify({ source: "instant_payment", order_id: order.id, tid: Number(reward.id), hero_id: characterId })]);
      } else {
        await connection.execute("INSERT INTO inventory_items (player_id,item_id,quantity,extra_json) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE quantity=quantity+VALUES(quantity),extra_json=VALUES(extra_json)",
          [order.player_id, reward.item_id, reward.amount, JSON.stringify({ source: "instant_payment", order_id: order.id, goods_id: product.goods_id || null })]);
        if (reward.item_id === "diamond" || reward.item_id === "gold") {
          await connection.execute(`UPDATE players SET ${reward.item_id}=${reward.item_id}+? WHERE id=?`, [reward.amount, order.player_id]);
        }
      }
      await connection.execute("INSERT IGNORE INTO payment_entitlements (order_id,player_id,entitlement_key,amount,payload_json) VALUES (?,?,?,?,?)",
        [order.id, order.player_id, `${reward.type}:${reward.id}`, reward.amount, JSON.stringify(reward)]);
    }
    await connection.execute("UPDATE payment_orders SET status='fulfilled',paid_at=COALESCE(paid_at,NOW()),fulfilled_at=NOW(),receipt_json=? WHERE id=?",
      [JSON.stringify({ provider: "sandbox", signature: providedSignature, verified: true }), order.id]);
    await connection.commit();
    return { ok: true, order_id: order.id, order_status: "fulfilled", goods_id: product.goods_id || null, rewards: product.rewards, sandbox: true, instant_grant: true, evidence_level: "official_charge_catalog_local_instant_fulfillment" };
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function purchaseNow(pool, playerId, request = {}) {
  const created = await createOrder(pool, playerId, request);
  if (!created.ok) return created;
  const order = created.order;
  if (order.status === "fulfilled") {
    const [entitlements] = await pool.execute("SELECT entitlement_key,amount,payload_json FROM payment_entitlements WHERE order_id=? ORDER BY id", [order.id]);
    return { ok: true, order_id: order.id, order_status: "fulfilled", rewards: entitlements.map((row) => typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json), idempotent_replay: true, sandbox: true, instant_grant: true };
  }
  return confirmOrder(pool, order.id, signature(order.id));
}

function catalog() {
  return Object.values(chargeTable()).filter((row) => Number(row.CHNCost ?? row.Cost ?? 0) >= 0).slice(0, 500).map((row) => skuInfo(row.ID));
}

module.exports = { catalog, confirmOrder, createOrder, goodsInfo, purchaseInfo, purchaseNow, signature, skuInfo, tokenAssets };
