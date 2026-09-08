const mysql = require("mysql2/promise");
const { loadConfig } = require("../lib/official-config-catalog");

async function main() {
  const accountSelector = process.argv[2] || "afk_test03";
  const requestedStage = Number(process.argv[3] || 0);
  const connection = await mysql.createConnection({
    host: process.env.AFK_DB_HOST || "127.0.0.1",
    port: Number(process.env.AFK_DB_PORT || 3307),
    user: process.env.AFK_DB_USER || "afk_local",
    password: process.env.AFK_DB_PASSWORD || "afk-local-only",
    database: process.env.AFK_DB_NAME || "AFK",
  });
  try {
    const [players] = await connection.execute(
      "SELECT p.id,p.player_uid,a.provider_uid FROM players p JOIN accounts a ON a.id=p.account_id WHERE a.provider_uid=? OR p.player_uid=? ORDER BY (p.player_uid=?) DESC LIMIT 1",
      [accountSelector, accountSelector, accountSelector]
    );
    if (!players.length) throw new Error(`player_not_found:${accountSelector}`);
    const playerId = Number(players[0].id);
    const unitLevels = loadConfig("UnitLevel").table;
    const unitQualities = loadConfig("UnitQuality").table;
    const maxInternalLevel = Math.max(...Object.keys(unitLevels).map(Number).filter(Number.isFinite));
    // MuMu1 has now completed a native 61-59 victory at level index 8000.
    // Index 18000 is absent from its downloaded Classic runtime and crashes
    // the native +HP lookup, so 8000 is the highest device-verified default.
    const requestedInternalLevel = Number(process.env.AFK_GRADUATED_INTERNAL_LEVEL || 8000);
    const graduatedInternalLevel = unitLevels[String(requestedInternalLevel)] ? requestedInternalLevel : Math.min(8000, maxInternalLevel);
    const maxRank = Number(unitLevels[String(graduatedInternalLevel)]?.Rank || 14);
    const units = Object.values(loadConfig("Unit").table).filter((row) =>
      row && row.Enable !== false && row.UnitType === "Hero" && Number(row.ID) > 0
    );
    const pets = Object.values(loadConfig("Pet").table).filter((row) => row && row.Enable !== false);
    const equipmentRows = Object.values(loadConfig("Equip").table).filter((row) =>
      row && Number(row.TID) > 0 && Number(row.Position) > 0
    );
    const furnitureRows = Object.values(loadConfig("HomelandFurnitureUnit").table).filter((row) =>
      row && Number(row.ID) > 0 && Number(row.HeroID) > 0
    );
    const artifactRows = Object.values(loadConfig("Artifact").table).filter((row) =>
      row && Number(row.ID) > 0
    );
    const signatureMaxLevelByHeroId = new Map(
      Object.values(loadConfig("SignatureLevel").table)
        .map((levels) => {
          const heroId = Number(levels && levels["0"] && levels["0"].HeroID);
          const maxLevel = Math.max(
            0,
            ...Object.keys(levels || {}).map(Number).filter(Number.isFinite),
          );
          return [heroId, maxLevel];
        })
        .filter(([heroId, maxLevel]) => heroId > 0 && maxLevel > 0)
    );
    // Keep five complete teams of device-verified Classic heroes above newer
    // catalog entries whose art is not present in MuMu1's Classic bundle.
    const preferredBattleTids = [
      34, 20, 9, 5, 4,
      47, 46, 45, 44, 43,
      42, 41, 39, 38, 37,
      36, 35, 33, 32, 28,
      27, 26, 25, 16, 14,
    ];
    const preferredBattleOrder = new Map(preferredBattleTids.map((tid, index) => [tid, index]));
    const stageRows = Object.values(loadConfig("Stage").table).filter((row) =>
      row && row.Enable !== false && Number(row.StageID) > 0
    );
    const maxStage = Math.max(...stageRows.map((row) => Number(row.StageID)));
    // cur_stage points at the next playable stage. After the last configured
    // battle it may therefore be maxStage + 1; do not roll a progressed QA
    // account backwards when reapplying its graduated roster.
    const campaignStage = requestedStage > 0
      ? Math.min(maxStage + 1, Math.trunc(requestedStage))
      : maxStage;
    const assets = [
      "diamond", "gold", "hero_exp", "dust", "friend_coin", "homeland_coin", "wish_coin",
      "arena_ticket", "maze_coin", "guild_coin", "labyrinth_coin", "challenger_coin",
      "item_13", "item_14", "item_47", "item_398", "item_2044", "item_6000", "item_6001",
      "meta_campaign_cur_stage", "meta_tower_floor", "meta_arena_point", "meta_arena_rank",
      "meta_battle_pass_level", "meta_battle_pass_exp", "meta_guild_boss_attempts",
      "meta_tavern_amazing_point",
      ...[1, 5, 6, 7, 12, 14, 15, 25, 26, 27, 28, 29, 30].map((poolId) => `meta_tavern_draw_count_${poolId}`),
    ];
    await connection.beginTransaction();
    await connection.execute(
      "UPDATE players SET nickname=?,level=?,exp=?,gold=?,diamond=?,profile_json=? WHERE id=?",
      ["毕业测试号", 999, 999999999, 999999999, 999999999,
        JSON.stringify({ source: "graduated_test_account", vip_level: 20, avatar: "avatar:102", frame: 1, all_features_unlocked: true,
          pentagram_level: graduatedInternalLevel, max_pentagram_level: graduatedInternalLevel, hero_aid_level: graduatedInternalLevel }), playerId]
    );
    for (const itemId of assets) {
      let quantity = 999999999;
      if (itemId === "meta_campaign_cur_stage") quantity = campaignStage;
      if (itemId === "meta_tower_floor") quantity = 9999;
      if (itemId === "meta_arena_rank") quantity = 1;
      if (itemId === "meta_battle_pass_level") quantity = 999;
      await connection.execute(
        "INSERT INTO inventory_items(player_id,item_id,quantity,extra_json) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE quantity=VALUES(quantity),extra_json=VALUES(extra_json)",
        [playerId, itemId, quantity, JSON.stringify({ source: "graduated_test_account" })]
      );
    }
    // Keep the low-tier equipment shown by the Classic enhancement material
    // picker authoritative and consumable after reconnects.  The client sends
    // these as AssetType=8 with the equipment TID as the material id.
    for (const equipTid of equipmentRows.map((row) => Number(row.ID)).filter((tid) => tid >= 1 && tid <= 156)) {
      await connection.execute(
        "INSERT INTO inventory_items(player_id,item_id,quantity,extra_json) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE quantity=VALUES(quantity),extra_json=VALUES(extra_json)",
        [playerId, `equip_${equipTid}`, 999, JSON.stringify({ source: "graduated_test_account", asset_type: "equip", asset_id: equipTid, equip_id: equipTid, tid: equipTid })]
      );
    }
    const graduatedHeroByTid = new Map();
    for (const unit of units) {
      const tid = Number(unit.ID);
      const supportedQualities = Object.keys(unitQualities[String(tid)] || {}).map(Number).filter(Number.isFinite);
      // Never project a synthetic quality above the hero's Classic table.
      // Quality 20 has no frame/progression row for these 1.201 heroes; the
      // roster still counted them but failed while constructing every cell,
      // leaving the entire Hero page and target selectors blank.
      const highestSupportedQuality = supportedQualities.length
        ? Math.max(...supportedQualities)
        : Number(unit.MaxQuality || 7);
      const maxQuality = Math.min(Number(unit.MaxQuality || highestSupportedQuality), highestSupportedQuality);
      const equips = {};
      for (const position of [1, 2, 3, 4]) {
        const best = equipmentRows
          // MuMu1's installed Classic resource bundle ends before quality-14
          // equipment (TID 157-168), even though the newer server catalog has
          // those rows.  Quality 13 is the highest tier present on both sides.
          .filter((row) => row.Job === unit.HeroJob && Number(row.Position) === position && Number(row.Quality) <= 13)
          .sort((left, right) => Number(right.Quality) - Number(left.Quality) || Number(right.TID) - Number(left.TID))[0];
        if (!best) continue;
        equips[String(position)] = {
          id: (100000 + tid) * 10 + position,
          tid: Number(best.TID),
          amount: 1,
          enhance_lv: 5,
          enhance_exp: 0,
          source_tid: Number(best.TID),
        };
      }
      const furnitures = furnitureRows
        .filter((row) => Number(row.HeroID) === tid && Number(row.Quality) === 9)
        .sort((left, right) => Number(left.ID) - Number(right.ID))
        .slice(0, 9)
        .map((row, index) => ({
          id: (100000 + tid) * 100 + index + 1,
          // The wire furniture.tid indexes HomelandFurniture (DisplayID).
          // HomelandFurnitureUnit.ID is a server-side variant id and is not a
          // valid client display/config key.
          tid: Number(row.DisplayID),
          lv: 0,
          hero_race_tag: Number(row.HeroTagID || unit.HeroTagID || 0),
          astrolabe_tag: Number(row.AstrolabeTag || unit.AstrolabeTag || 0),
          hero_tag: Number(row.HeroID || tid),
        }));
      const matchingArtifacts = artifactRows
        .filter((row) => row.Type === "AstrolabeTag" && Number(row.AstrolabeTag) === Number(unit.AstrolabeTag || 0))
        .sort((left, right) => Number(right.ID) - Number(left.ID));
      const artifact = matchingArtifacts[0] || artifactRows.find((row) => Number(row.ID) === 3);
      const extra = {
        hero_id: 100000 + tid,
        tid,
        max_level: graduatedInternalLevel,
        quality: maxQuality,
        trans_quality: maxQuality,
        rank: maxRank,
        // Stable early Classic heroes have complete local animation,
        // signature and furniture resources; keep them first in formation
        // sorting so the default QA team exercises every growth subsystem.
        gs: preferredBattleOrder.has(tid)
          ? 2100000000 - preferredBattleOrder.get(tid) * 1000000
          : 2000000000,
        artifact_id: Number(artifact && artifact.ID || 3),
        artifact_tid: Number(artifact && artifact.ID || 3),
        artifact_awaken_lv: 5,
        artifact_lv: 5,
        pentagram_lv: graduatedInternalLevel,
        // Signature caps differ by hero (and by Classic/HD delivery). Keep
        // persisted progression inside the authoritative table; the client
        // patch independently selects the highest icon row it actually ships.
        signature_level: signatureMaxLevelByHeroId.get(tid) || 0,
        furniture_level: furnitures.length,
        engraving_level: 100,
        equips,
        furnitures,
        source: "graduated_test_account",
      };
      graduatedHeroByTid.set(tid, { level: graduatedInternalLevel, star: maxQuality, extra });
      await connection.execute(
        "INSERT INTO characters(player_id,character_id,level,star,extra_json) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE level=VALUES(level),star=VALUES(star),extra_json=VALUES(extra_json)",
        [playerId, `graduate_hero_${tid}`, graduatedInternalLevel, maxQuality, JSON.stringify(extra)]
      );
    }
    // A QA account can already contain starter or tavern-drawn copies of a
    // hero. The Classic roster renders every owned copy, so leaving those
    // historical rows at level 1 makes an otherwise graduated account appear
    // only partially levelled. Apply the same maxed profile to every existing
    // playable copy while preserving its stable instance id and provenance.
    const [existingCharacters] = await connection.execute(
      "SELECT character_id,level,star,extra_json FROM characters WHERE player_id=?",
      [playerId]
    );
    for (const character of existingCharacters) {
      const currentExtra = typeof character.extra_json === "string"
        ? JSON.parse(character.extra_json || "{}")
        : (character.extra_json || {});
      if (currentExtra.kind === "pet" || currentExtra.assist_uid != null) continue;
      const tid = Number(currentExtra.tid || currentExtra.hero_id || character.character_id);
      const graduated = graduatedHeroByTid.get(tid);
      if (!graduated) continue;
      const mergedExtra = {
        ...graduated.extra,
        hero_id: Number(currentExtra.hero_id || graduated.extra.hero_id),
        original_source: currentExtra.source || "legacy_owned_hero",
        source: "graduated_test_account_existing_copy",
      };
      await connection.execute(
        "UPDATE characters SET level=?,star=?,extra_json=? WHERE player_id=? AND character_id=?",
        [graduated.level, graduated.star, JSON.stringify(mergedExtra), playerId, String(character.character_id)]
      );
    }
    for (const pet of pets) {
      const tid = Number(pet.ID);
      await connection.execute(
        "INSERT INTO characters(player_id,character_id,level,star,extra_json) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE level=VALUES(level),star=VALUES(star),extra_json=VALUES(extra_json)",
        [playerId, `graduate_pet_${tid}`, Number(pet.MaxLevel || 18), 5,
          JSON.stringify({ pet_id: tid, tid, kind: "pet", max_level: Number(pet.MaxLevel || 18), source: "graduated_test_account" })]
      );
    }
    await connection.execute(
      "INSERT INTO stage_progress(player_id,stage_id,best_result_json,cleared_at) VALUES(?,?,?,NOW()) ON DUPLICATE KEY UPDATE best_result_json=VALUES(best_result_json),cleared_at=NOW()",
      [playerId, String(campaignStage), JSON.stringify({ result: "victory", source: "graduated_test_account" })]
    );
    await connection.commit();
    console.log(JSON.stringify({ ok: true, provider_uid: players[0].provider_uid, player_uid: players[0].player_uid,
      nickname: "毕业测试号", level: 999, max_stage: maxStage, campaign_stage: campaignStage,
      hero_internal_level: graduatedInternalLevel, hero_display_level: Number(unitLevels[String(graduatedInternalLevel)]?.DisplayLevel || graduatedInternalLevel),
      config_max_internal_level: maxInternalLevel,
      hero_rank: maxRank, heroes: units.length, pets: pets.length, assets: assets.length }, null, 2));
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
