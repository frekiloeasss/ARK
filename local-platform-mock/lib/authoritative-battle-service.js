const { randomUUID, createHash } = require("node:crypto");
const { battleEvidence, hasConfig, loadConfig } = require("./official-config-catalog");

const UNIT_LEVELS = loadConfig("UnitLevel").table;
const UNITS = loadConfig("Unit").table;
const UNIT_HEROES = loadConfig("UnitHero").table;
const UNIT_QUALITIES = loadConfig("UnitQuality").table;
const UNIT_RANKS = loadConfig("UnitRank").table;
const UNIT_RES = loadConfig("UnitRes").table;
const ANIM_DURATION = loadConfig("AnimDuration").table;
const TOWER = loadConfig("StageBattleTower").table;
const ARTIFACT_RANKS = loadConfig("ArtifactRank").table;
const SIGNATURE_LEVELS = loadConfig("SignatureLevel").table;
const PET_LEVELS = loadConfig("PetLevelAttribute").table;
const EQUIPMENT = loadConfig("Equip").table;
const EQUIP_RESONATE = loadConfig("EquipResonate").table;
const STAGES = loadConfig("Stage").table;
const chapterCache = new Map();

function seedFrom(value) { const digest = createHash("sha256").update(String(value)).digest(); return digest.readUInt32LE(0) || 1; }
function rng32(seed) { let value = seed >>> 0; return () => { value = (value + 0x6d2b79f5) >>> 0; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function closestNumericRow(rows, requested) {
  if (!rows || typeof rows !== "object") return {};
  if (rows[String(requested)]) return rows[String(requested)];
  const keys = Object.keys(rows).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return {};
  const eligible = keys.filter((key) => key <= Number(requested));
  return rows[String(eligible.length ? eligible[eligible.length - 1] : keys[0])] || {};
}

// UnitQuality/UnitRank are keyed by the real unit TID. UnitHero is a flat
// quality-upgrade catalogue and its numeric key is not a hero TID.
function qualityRow(tid, quality) {
  return closestNumericRow(UNIT_QUALITIES[String(tid)] || UNIT_QUALITIES["1"] || {}, quality);
}
function rankRow(tid, rank) {
  return closestNumericRow(UNIT_RANKS[String(tid)] || UNIT_RANKS["1"] || {}, rank);
}

function growthBonuses(tid, extra = {}, battleOptions = {}) {
  const rows = [];
  const artifactId = Number(extra.artifact_id || extra.artifact?.tid || extra.artifact?.id || 0);
  const artifactRank = Number(extra.artifact_awaken_lv ?? extra.artifact_rank ?? extra.artifact?.awaken_lv ?? extra.artifact?.rank ?? 0);
  const artifactRow = closestNumericRow(ARTIFACT_RANKS[String(artifactId)], artifactRank);
  if (Object.keys(artifactRow).length) rows.push({ source: `ArtifactRank:${artifactId}:${Number(artifactRow.Rank ?? artifactRank)}`, row: artifactRow });
  const signatureLevel = Number(extra.signature_level || extra.sig_level || extra.sig?.level || 0);
  const signatureRow = closestNumericRow(SIGNATURE_LEVELS[String(tid)], signatureLevel);
  if (Object.keys(signatureRow).length) rows.push({ source: `SignatureLevel:${tid}:${Number(signatureRow.Level ?? signatureLevel)}`, row: signatureRow });
  const petId = Number(battleOptions.pet_id || extra.pet_id || 0), petLevel = Number(battleOptions.pet_level || extra.pet_level || 0);
  const petRow = closestNumericRow(PET_LEVELS[String(petId)], petLevel);
  if (Object.keys(petRow).length) rows.push({ source: `PetLevelAttribute:${petId}:${petLevel}`, row: petRow });
  const equips = Array.isArray(extra.equips) ? extra.equips : Object.values(extra.equips || {});
  for (const instance of equips) {
    const equip = instance && typeof instance === "object" ? instance : { tid: instance };
    const sourceTid = Number(equip.tid || equip.source_tid || equip.id || 0);
    const equipTid = Number(equip.resonate_tid || sourceTid);
    const config = EQUIPMENT[String(equipTid)];
    if (!config) continue;
    const resonateLevel = equip.resonate_tid ? Number(EQUIP_RESONATE[String(config.Quality)]?.Enhancement || 0) : 0;
    const enhanceLevel = Math.max(0, Number(equip.enhance_lv || 0), resonateLevel);
    const heroTagId = Number(UNITS[String(tid)]?.HeroTagID || 0);
    const tagMatches = Number(equip.refine_tag || equip.hero_tag || 0) === heroTagId;
    const tagBonusRate = Math.max(1, Number(equip.tag_bonus_rate || (tagMatches ? config.TagBonusRate : 1) || 1));
    const derived = {};
    for (const attr of ["HP","ATK","ARM","MR","CRIT","MCRIT","DODG","HIT","HAST","MSPD","HPR","PIMU","MIMU","LFS","DCRIT","CRITP","CRITD","RES","INSIGHT","DPIMU","DMIMU"]) {
      derived[attr] = Number(config[attr] || 0) * tagBonusRate + enhanceLevel * Number(config[`Add${attr}`] || 0);
    }
    rows.push({ source: `Equip:${sourceTid}${equip.resonate_tid ? `=>${equipTid}` : ""}:+${enhanceLevel}`, row: derived });
  }
  const sum = (key) => rows.reduce((total, entry) => total + Number(entry.row[key] || 0), 0);
  const maze = battleOptions.maze_relic_effects || {};
  const mazeRows = Number(maze.stack_count || 0) > 0 ? [`MazeHeirlooms:${Number(maze.stack_count)}`] : [];
  return { rows: [...rows.map((entry) => entry.source), ...mazeRows], hpPct: sum("HP.PR") + Number(maze.hp_pct || 0), atkPct: sum("ATK.PR") + Number(maze.atk_pct || 0), armPct: sum("ARM.PR"), mrPct: sum("MR.PR"),
    hpAdd: sum("HP") + sum("HPadd"), atkAdd: sum("ATK") + sum("ATKadd"), armAdd: sum("ARM") + sum("ARMadd"), mrAdd: sum("MR") + sum("MRadd"), haste: sum("HAST") + Number(maze.haste || 0), crit: sum("CRIT") + sum("MCRIT"),
    dodge: sum("DODG") + sum("MDODG"), hit: sum("HIT") + sum("MHIT"), lifesteal: sum("LFS"), physicalImmunity: sum("PIMU"), magicImmunity: sum("MIMU") };
}

function statsFor(tid, level = 1, quality = 1, overrides = {}) {
  const levelRow = UNIT_LEVELS[String(Math.max(1, Number(level)))] || UNIT_LEVELS["1"];
  const unit = UNITS[String(tid)] || UNITS["1"] || {};
  const q = qualityRow(tid, Math.max(1, Number(quality))); const rank = Number(overrides.rank || levelRow.Rank || 1); const r = rankRow(tid, rank);
  const stat = (name, fallback) => {
    const fixed = Number(unit[name] || 0) + (Number(levelRow[`+${name}`]) || fallback) * Number(unit[`+${name}Coef`] || 1) + Number(r[`+${name}`] || 0);
    return fixed * Number(q[name] || 1) + Number(q[`Add${name}`] || 0);
  };
  const res = UNIT_RES[String(tid)] || {}; const puppet = res.Puppet || ""; const timing = ANIM_DURATION[puppet] || {};
  const attackDuration = Math.max(0.25, Number(timing.atk?.Duration || timing.atk2?.Duration || 1.2));
  const bonus = overrides.growth || growthBonuses(tid, {}, overrides);
  const withBonus = (base, pct, add) => (base + Number(add || 0)) * (1 + Number(pct || 0) / 100);
  return { tid: Number(tid), level: Number(level), quality: Number(quality), rank, puppet,
    hp: Math.max(1, withBonus(stat("HP",45) * Number(overrides.hpScale || 1), bonus.hpPct, bonus.hpAdd)),
    atk: Math.max(1, withBonus(stat("ATK",3.8) * Number(overrides.atkScale || 1), bonus.atkPct, bonus.atkAdd)),
    arm: Math.max(0, withBonus(stat("ARM",.8), bonus.armPct, bonus.armAdd)), mr: Math.max(0, withBonus(stat("MR",.8), bonus.mrPct, bonus.mrAdd)),
    haste: Math.max(.25, 1 + ((Number(levelRow["+HAST"]) || 0) + Number(bonus.haste || 0)) / 100),
    crit: Math.max(0, Math.min(.75, ((Number(levelRow["+CRIT"]) || 0) + Number(bonus.crit || 0)) / 10000 + .05)),
    dodge: Math.max(0, Number(bonus.dodge || 0)), hit: Math.max(0, Number(bonus.hit || 0)), lifesteal: Math.max(0, Number(bonus.lifesteal || 0)),
    physicalImmunity: Math.max(0, Number(bonus.physicalImmunity || 0)), magicImmunity: Math.max(0, Number(bonus.magicImmunity || 0)), attackDuration,
    source: { level: "UnitLevel", quality: "UnitQuality", rank: "UnitRank", animation: "AnimDuration", growth: bonus.rows || [] } };
}

function stageConfig(mode, stageId) {
  if (mode === "tower") return TOWER[String(20000 + Number(stageId))] || TOWER[String(stageId)] || null;
  const id = String(stageId);
  const stage = STAGES[id];
  if (stage) {
    const chapter = Number(stage.ChapterID || 0);
    const name = `StageBattleChap${chapter}`;
    if (chapter > 0 && hasConfig(name)) {
      if (!chapterCache.has(name)) chapterCache.set(name, loadConfig(name).table);
      const table = chapterCache.get(name);
      const byName = Object.values(table).find((row) => row && row.StageName === stage.StageName);
      if (byName) return byName;
      for (const battleId of stage.BattleID || []) if (table[String(battleId)]) return table[String(battleId)];
    }
  }
  for (let chapter = 1; chapter <= 79; chapter += 1) {
    const name = `StageBattleChap${chapter}`; if (!hasConfig(name)) continue;
    if (!chapterCache.has(name)) chapterCache.set(name, loadConfig(name).table);
    if (chapterCache.get(name)[id]) return chapterCache.get(name)[id];
  }
  for (const name of ["StageBattleBoss","StageBattleOther","StageBattleRaid"]) if (hasConfig(name) && loadConfig(name).table[id]) return loadConfig(name).table[id];
  return null;
}

function mazeAssistCharacters(state) {
  const row = (state.inventory || []).find((item) => String(item.item_id) === "meta_maze_run");
  let run = row?.extra_json?.run || row?.extra?.run || null;
  if (typeof run === "string") { try { run = JSON.parse(run); } catch { run = null; } }
  return (run?.assist_heroes || []).map((hero) => ({
    character_id: String(hero.id || hero.hero_id),
    level: Number(hero.level || 240),
    star: Number(hero.quality || 8),
    extra_json: {
      hero_id: Number(hero.id || hero.hero_id),
      tid: Number(hero.tid || 22),
      quality: Number(hero.quality || 8),
      rank: Number(hero.rank || 10),
      gs: Number(hero.gs || 120000),
      source: "maze_carriage",
    },
  }));
}

function playerTeam(state, lineupIds = [], battleOptions = {}) {
  const selected = new Set((lineupIds || []).map(String));
  let heroes = [
    ...(state.characters || []).filter((row) => !String(row.character_id).startsWith("assist_")),
    ...(String(battleOptions.mode || "") === "maze" ? mazeAssistCharacters(state) : []),
  ];
  if (selected.size) heroes = heroes.filter((row) => selected.has(String(row.character_id)) || selected.has(String(row.extra_json?.hero_id)));
  return heroes.slice(0,5).map((row,index) => ({ id: String(row.character_id), slot:index+1,
    ...statsFor(Number(row.extra_json?.tid || row.extra_json?.hero_id || 1), Number(row.level || 1), Number(row.extra_json?.quality || row.star || 1), {
      rank: row.extra_json?.rank || 1, growth: growthBonuses(Number(row.extra_json?.tid || row.extra_json?.hero_id || 1), row.extra_json || {}, battleOptions),
    }) }));
}
function enemyTeam(mode, stageId, battleOptions = {}) {
  const config = stageConfig(mode,stageId); if (!config) return [];
  const hpScale=Math.max(.1,Number(config.MonsterHpMode||100)/100),atkScale=Math.max(.1,Number(config.MonsterDpsMode||100)/100);
  const enemyLevelCap = Math.max(0, Number(battleOptions.enemy_level_cap || 0));
  return (config.MonsterIDList||[]).map((tid,index)=>({tid,index})).filter(x=>Number(x.tid)>0).map(({tid,index})=>({id:`enemy_${stageId}_${index+1}`,slot:index+1,
    ...statsFor(tid,enemyLevelCap > 0 ? Math.min(Number(config.LevelList?.[index]||1),enemyLevelCap) : Number(config.LevelList?.[index]||1),Number(config.QualityList?.[index]||1),{hpScale,atkScale,rank:config.RankList?.[index]||1})}));
}
function enemyTeamFromLineup(lineup = [], opponentId = 0) {
  return (lineup || []).slice(0, 5).map((row, index) => ({
    id: `bot_${opponentId}_${index + 1}`, slot: Number(row.slot || index + 1),
    ...statsFor(Number(row.tid || row.hero_id || 1), Number(row.level || 1), Number(row.quality || 1), { rank: Number(row.rank || 1) }),
  }));
}
function teamPower(team) { return Math.round(team.reduce((sum,h)=>sum+h.hp+h.atk*10+(h.arm+h.mr)*3,0)); }

function simulateBattle(self, enemy, seed, maxSeconds = 90) {
  const random=rng32(seed), events=[]; let eventSeq=0;
  const make=(h,side)=>({...h,side,currentHp:h.hp,energy:0,shield:0,nextAction:Math.max(.1,h.attackDuration/h.haste),actionCount:0,controlledUntil:0,dots:[]});
  const left=self.map(h=>make(h,"self")),right=enemy.map(h=>make(h,"enemy")); const all=[...left,...right];
  const alive=t=>t.filter(h=>h.currentHp>0); const log=(time,type,data)=>{if(events.length<1200)events.push({seq:++eventSeq,time:Number(time.toFixed(3)),type,...data})};
  const damage=(time,attacker,target,multiplier,kind)=>{const hitChance=Math.max(.2,Math.min(.98,.9+(attacker.hit-target.dodge)/10000));if(random()>hitChance){log(time,"dodge",{side:target.side,from:attacker.id,to:target.id});return 0}const crit=random()<attacker.crit,defence=kind==="magic"?target.mr:target.arm;const immunity=Math.max(0,Math.min(.8,Number(kind==="magic"?target.magicImmunity:target.physicalImmunity)/100));const raw=attacker.atk*multiplier*(crit?1.75:1)*(.94+random()*.12);
    // Raw ARM/MR scales into the hundreds of billions in late Classic
    // UnitLevel rows. A fixed `100/(100+defence)` denominator therefore
    // reduces every max-level hit to single digits. Normalise defence against
    // the attacker's current ATK so equal-growth combat keeps the same pace
    // and a genuinely stronger team retains its advantage.
    const mitigation=Math.max(.05,Math.min(1,attacker.atk/Math.max(1,attacker.atk+defence)));let dealt=Math.max(1,raw*mitigation*(1-immunity));const absorbed=Math.min(target.shield,dealt);target.shield-=absorbed;dealt-=absorbed;target.currentHp=Math.max(0,target.currentHp-dealt);target.energy=Math.min(1000,target.energy+Math.round(45+dealt/Math.max(1,target.hp)*220));attacker.energy=Math.min(1000,attacker.energy+110);const stolen=Math.min(attacker.hp-attacker.currentHp,dealt*Math.min(.8,attacker.lifesteal/100));attacker.currentHp+=stolen;log(time,"damage",{side:attacker.side,from:attacker.id,to:target.id,kind,damage:Math.round(dealt),absorbed:Math.round(absorbed),crit,remaining_hp:Math.round(target.currentHp),energy:target.energy,lifesteal:Math.round(stolen)});if(target.currentHp===0)log(time,"death",{side:target.side,unit:target.id});return dealt};
  let time=0;
  while(alive(left).length&&alive(right).length&&time<maxSeconds){
    const candidates=all.filter(h=>h.currentHp>0).sort((a,b)=>a.nextAction-b.nextAction||a.slot-b.slot);if(!candidates.length)break;const actor=candidates[0];time=actor.nextAction;if(time>maxSeconds)break;
    if(actor.controlledUntil>time){actor.nextAction=actor.controlledUntil;continue}const allies=actor.side==="self"?left:right,enemies=actor.side==="self"?right:left,targets=alive(enemies);if(!targets.length)break;actor.actionCount+=1;
    if(actor.energy>=1000){actor.energy=0;const role=actor.tid%5;log(time,"ultimate",{side:actor.side,unit:actor.id,role});
      if(role===0){for(const ally of alive(allies)){const healed=Math.min(ally.hp-ally.currentHp,actor.atk*2.4);ally.currentHp+=healed;log(time,"heal",{side:actor.side,from:actor.id,to:ally.id,amount:Math.round(healed)})}}
      else if(role===1){for(const ally of alive(allies)){ally.shield+=actor.atk*2;log(time,"shield",{side:actor.side,from:actor.id,to:ally.id,amount:Math.round(actor.atk*2)})}}
      else {for(const target of targets){const dealt=damage(time,actor,target,role===2?1.15:1.45,role===3?"magic":"physical");if(role===4&&dealt>0){target.dots.push({source:actor.id,damage:actor.atk*.18,ticks:3});log(time,"status",{from:actor.id,to:target.id,effect:"burn",ticks:3})}}if(role===2&&targets[0]){targets[0].controlledUntil=time+1.5;log(time,"control",{from:actor.id,to:targets[0].id,effect:"stun",until:targets[0].controlledUntil})}}
      actor.nextAction=time+Math.max(.4,Number(ANIM_DURATION[actor.puppet]?.ult?.Duration||2.4)/actor.haste);continue;
    }
    for(const unit of all.filter(row=>row.currentHp>0&&row.dots.length)){for(const dot of unit.dots){const tick=Math.min(unit.currentHp,dot.damage);unit.currentHp-=tick;dot.ticks-=1;log(time,"dot",{from:dot.source,to:unit.id,damage:Math.round(tick),remaining_hp:Math.round(unit.currentHp)})}unit.dots=unit.dots.filter(dot=>dot.ticks>0)}
    const target=targets.reduce((best,row)=>row.currentHp<best.currentHp?row:best,targets[0]);
    if(actor.actionCount%3===0){const role=actor.tid%4;if(role===0){const ally=alive(allies).sort((a,b)=>a.currentHp/a.hp-b.currentHp/b.hp)[0];const healed=Math.min(ally.hp-ally.currentHp,actor.atk*1.35);ally.currentHp+=healed;actor.energy=Math.min(1000,actor.energy+140);log(time,"skill_heal",{side:actor.side,from:actor.id,to:ally.id,amount:Math.round(healed)})}else damage(time,actor,target,1.35,role===1?"magic":"physical");}else damage(time,actor,target,1,"physical");
    actor.nextAction=time+Math.max(.25,actor.attackDuration/actor.haste);
  }
  const selfAlive=alive(left).length,enemyAlive=alive(right).length,result=enemyAlive===0&&selfAlive>0?"victory":"defeat";
  return { engine_version:"afk-local-authoritative-v2",result,duration:Number(Math.min(time,maxSeconds).toFixed(3)),self_alive:selfAlive,enemy_alive:enemyAlive,events,
    final_units:all.map(h=>({id:h.id,side:h.side,hp:Math.round(h.currentHp),max_hp:Math.round(h.hp),energy:h.energy,shield:Math.round(h.shield)})),
    mechanics:["deterministic_timeline","animation_duration","energy","ultimate","skill_cycle","shield","heal","control","armor","magic_resist","critical","haste","hit","dodge","lifesteal","damage_immunity","damage_over_time","artifact","signature","pet"] };
}

function startAuthoritativeBattle(state,request={}) { const mode=String(request.mode||"campaign"),stageId=Number(request.stage_id||request.floor_id||1),self=playerTeam(state,request.lineup_ids||[],request),enemy=Array.isArray(request.enemy_lineup)&&request.enemy_lineup.length?enemyTeamFromLineup(request.enemy_lineup,request.opponent_uid||stageId):enemyTeam(mode,stageId,request);
  if(!self.length)return{ok:false,status:409,error:"battle_lineup_empty"};if(!enemy.length)return{ok:false,status:404,error:"battle_stage_not_found",mode,stage_id:stageId};const battleId=request.battle_id||randomUUID(),seed=Number(request.seed||seedFrom(`${battleId}:${mode}:${stageId}`)),simulation=simulateBattle(self,enemy,seed);
  return{ok:true,battle_id:battleId,mode,stage_id:stageId,seed,lineup_ids:self.map(x=>x.id),self_power:teamPower(self),enemy_power:teamPower(enemy),self_team:self,enemy_team:enemy,maze_relic_effects:request.maze_relic_effects||null,server_result:simulation.result,simulation,
    official_client_evidence:battleEvidence(),evidence_level:"decrypted_official_configs_and_client_battle_source_local_authoritative_execution",
    fidelity_boundary:"Recovered client battle source is retained as the oracle; this server runtime is an independent deterministic implementation, not official private server code."}; }
function finishAuthoritativeBattle(record,clientResult){if(!record||!record.ok)return{ok:false,status:404,error:"active_battle_not_found"};const reported=String(clientResult||"").toLowerCase();return{ok:true,battle_id:record.battle_id,result:record.server_result,client_result:reported,verified:reported===record.server_result,rejected_client_result:Boolean(reported&&reported!==record.server_result),simulation:record.simulation,evidence_level:record.evidence_level};}

module.exports={enemyTeam,enemyTeamFromLineup,finishAuthoritativeBattle,growthBonuses,playerTeam,simulateBattle,stageConfig,startAuthoritativeBattle,statsFor,teamPower};
