const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const secretsPath = path.join(ROOT, "runtime", "private-server-secrets.json");
const ADMIN_PASSWORD = fs.existsSync(secretsPath) ? JSON.parse(fs.readFileSync(secretsPath, "utf8").replace(/^\uFEFF/, "")).admin_password : "afk-admin-local";
function port() { return new Promise((resolve, reject) => { const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));}); s.on("error",reject); }); }
function startServer(p) {
  return spawn(process.execPath, ["server.js","--host","127.0.0.1","--port",String(p),"--proxy-unknown","0"], {
    cwd: ROOT, env: { ...process.env, AFK_DB_ENABLED:"1", AFK_DB_HOST:"127.0.0.1", AFK_DB_PORT:"3307", AFK_DB_USER:"afk_local", AFK_DB_PASSWORD:"afk-local-only", AFK_DB_NAME:"AFK", AFK_ADMIN_USER:"admin", AFK_ADMIN_PASSWORD:ADMIN_PASSWORD }, stdio:["ignore","pipe","pipe"]
  });
}
async function wait(url) { for(let i=0;i<50;i++){try{const r=await fetch(url);if(r.ok)return r;}catch{} await new Promise(r=>setTimeout(r,200));} throw new Error("server did not start"); }
async function json(url, body, token) { const r=await fetch(url,{method:body===undefined?"GET":"POST",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)}); const data=await r.json(); if(!r.ok) throw new Error(`${r.status} ${JSON.stringify(data)}`); return data; }
async function stop(child) { if(!child.killed) child.kill(); await new Promise(resolve=>{child.once("exit",resolve);setTimeout(resolve,2000);}); }

async function main() {
  const p=await port(); let child=startServer(p); const base=`http://127.0.0.1:${p}`;
  await wait(`${base}/__afk/health`);
  const health=await json(`${base}/__afk/health`);
  if(!health.db.ready) throw new Error(`mysql not ready: ${JSON.stringify(health)}`);
  const suffix=`${Date.now()}_${process.pid}`;
  const account=await json(`${base}/__afk/accounts/register`,{username:`test_${suffix}`,password:"test-password-123"});
  const login=await json(`${base}/__afk/accounts/login`,{username:`test_${suffix}`,password:"test-password-123"});
  if(!account.ok||!login.token) throw new Error("account flow failed");
  const seeded=await json(`${base}/__afk/internal/structured-login`,{session_id:999,htoken:`mysql-smoke-${suffix}`,svr_id:19});
  const admin=await json(`${base}/__afk/accounts/login`,{username:"admin",password:ADMIN_PASSWORD});
  await json(`${base}/__afk/gm/action`,{action:"grant_asset",player_id:seeded.player_id,item_id:"diamond",amount:77},admin.token);
  await json(`${base}/__afk/gm/action`,{action:"run_resets",player_id:seeded.player_id,now_ts:Math.floor(Date.now()/1000)},admin.token);
  const battle=await json(`${base}/__afk/game/battles/start`,{player_uid:seeded.player_uid,mode:"campaign",stage_id:13,lineup_ids:[1],seed:9});
  const finish=await json(`${base}/__afk/game/battles/finish`,{player_uid:seeded.player_uid,battle_id:battle.battle_id,result:battle.server_result==="victory"?"defeat":"victory"});
  if(!finish.rejected_client_result) throw new Error("authoritative battle accepted forged result");
  const settlementBattle=await json(`${base}/__afk/game/battles/start`,{player_uid:seeded.player_uid,mode:"campaign",stage_id:13,lineup_ids:[1],seed:19});
  const settlement=await json(`${base}/__afk/game/stages/result`,{player_uid:seeded.player_uid,battle_id:settlementBattle.battle_id,result:settlementBattle.server_result,idempotency_key:`battle-${suffix}`});
  const settlementReplay=await json(`${base}/__afk/game/stages/result`,{player_uid:seeded.player_uid,battle_id:settlementBattle.battle_id,result:settlementBattle.server_result,idempotency_key:`battle-${suffix}`});
  if(settlement.idempotent_replay||!settlementReplay.idempotent_replay||settlementReplay.battle_id!==settlementBattle.battle_id) throw new Error(`battle settlement idempotency failed: ${JSON.stringify({settlement,settlementReplay})}`);
  const botStatus=await json(`${base}/__afk/bots/status`);
  if(botStatus.bot_count!==120||botStatus.guild_count<6) throw new Error(`bot ecosystem seed failed: ${JSON.stringify(botStatus)}`);
  const arena=await json(`${base}/__afk/game/action`,{player_uid:seeded.player_uid,op:"arena_open"});
  if(arena.opponents?.length!==5||!arena.opponents.every(row=>row.is_robot&&row.lineup?.length===5)) throw new Error(`bot matchmaking failed: ${JSON.stringify(arena)}`);
  const botBattle=await json(`${base}/__afk/game/action`,{player_uid:seeded.player_uid,op:"arena_challenge",opponent_uid:arena.opponents[0].bot_id});
  if(!botBattle.authoritative_battle||!botBattle.replay_id) throw new Error(`authoritative bot battle failed: ${JSON.stringify(botBattle)}`);
  const chat=await json(`${base}/__afk/social/chat`,{player_uid:seeded.player_uid,channel:"world",message:"mysql smoke"});
  if(!chat.bot_reply?.bot_id) throw new Error(`bot chat reply failed: ${JSON.stringify(chat)}`);
  const socialPeer=await json(`${base}/__afk/internal/structured-login`,{session_id:1000,htoken:`mysql-social-${suffix}`,svr_id:19});
  await json(`${base}/__afk/social/friends`,{player_uid:seeded.player_uid,friend_player_id:socialPeer.player_id,action:"request"});
  const incoming=await json(`${base}/__afk/social/friends?player_uid=${encodeURIComponent(socialPeer.player_uid)}`);
  if(!incoming.incoming_requests.some(row=>Number(row.friend_player_id)===Number(seeded.player_id))) throw new Error(`friend request not visible: ${JSON.stringify(incoming)}`);
  await json(`${base}/__afk/social/friends`,{player_uid:socialPeer.player_uid,friend_player_id:seeded.player_id,action:"accept"});
  const privateChat=await json(`${base}/__afk/social/chat`,{player_uid:seeded.player_uid,recipient_player_id:socialPeer.player_id,message:"private mysql smoke"});
  const socialEvents=await json(`${base}/__afk/social/events?player_uid=${encodeURIComponent(socialPeer.player_uid)}`);
  if(!privateChat.channel.startsWith("private:")||!socialEvents.events.some(row=>row.event_type==="private_chat")) throw new Error(`private social event failed: ${JSON.stringify({privateChat,socialEvents})}`);
  await json(`${base}/__afk/social/friends/gift`,{player_uid:seeded.player_uid,friend_player_id:socialPeer.player_id,action:"send"});
  const gift=await json(`${base}/__afk/social/friends/gift`,{player_uid:socialPeer.player_uid,action:"receive"});
  if(gift.received!==1) throw new Error(`friend gift failed: ${JSON.stringify(gift)}`);
  const eventOpen=await json(`${base}/__afk/systems/action`,{player_uid:seeded.player_uid,module:"hero_return",operation:"open_panel",request_seq:`open-${suffix}`});
  const eventAction=await json(`${base}/__afk/systems/action`,{player_uid:seeded.player_uid,module:"hero_return",operation:"call_hero",request_seq:`event-${suffix}`});
  const eventReplay=await json(`${base}/__afk/systems/action`,{player_uid:seeded.player_uid,module:"hero_return",operation:"call_hero",request_seq:`event-${suffix}`});
  if(eventOpen.liveops?.phase!=="active"||eventAction.idempotent_replay||!eventReplay.idempotent_replay) throw new Error(`HD liveops state/idempotency failed: ${JSON.stringify({eventOpen,eventAction,eventReplay})}`);
  const purchase=await json(`${base}/__afk/payments/orders`,{player_uid:seeded.player_uid,goods_id:987600046,idempotency_key:`instant-${suffix}`});
  if(purchase.order_status!=="fulfilled"||!purchase.instant_grant||!purchase.rewards.some(row=>row.item_id==="item_999"&&Number(row.amount)===10)) throw new Error(`instant recharge failed: ${JSON.stringify(purchase)}`);
  const replay=await json(`${base}/__afk/payments/orders`,{player_uid:seeded.player_uid,goods_id:987600046,idempotency_key:`instant-${suffix}`});
  if(!replay.idempotent_replay) throw new Error("instant recharge idempotency failed");
  const audit=await json(`${base}/__afk/gm/audit`,undefined,admin.token);
  if(!audit.records.length) throw new Error("gm audit missing");
  await stop(child);
  child=startServer(p); await wait(`${base}/__afk/health`);
  const restored=await json(`${base}/__afk/db/business-state?player_uid=${encodeURIComponent(seeded.player_uid)}`);
  const diamonds=restored.inventory.find(row=>row.item_id==="diamond")?.quantity;
  if(Number(diamonds)!==1000077) throw new Error(`restart persistence failed: ${diamonds}`);
  const chargedItem=restored.inventory.find(row=>row.item_id==="item_999")?.quantity;
  if(Number(chargedItem)<10) throw new Error(`instant recharge persistence failed: ${chargedItem}`);
  await stop(child);
  console.log("mysql persistence, account, GM, HD liveops, atomic battle settlement, multi-account social, bot ecosystem and instant recharge integration smoke ok");
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
