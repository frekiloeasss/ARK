const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const children = new Set();
const outputByChild = new WeakMap();

function pythonCandidates() {
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
  return candidates.filter(Boolean);
}

function findPython() {
  for (const command of pythonCandidates()) {
    if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
    const result = spawnSync(command, ["--version"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: false,
    });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error("Python launcher not found.");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  outputByChild.set(child, "");
  child.stdout.on("data", (chunk) => {
    outputByChild.set(child, outputByChild.get(child) + chunk.toString());
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    outputByChild.set(child, outputByChild.get(child) + chunk.toString());
    process.stderr.write(chunk);
  });
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitForHttp(url, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP mock exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function waitForOutput(pattern, child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`WebSocket mock exited early with code ${child.exitCode}.`);
    }
    if (pattern.test(outputByChild.get(child) || "")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for output matching ${pattern}.`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = start(command, args);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}.`));
    });
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function stopAll() {
  const running = [...children].filter((child) => child.exitCode === null);
  for (const child of running) child.kill("SIGTERM");
  await Promise.all(
    running.map(
      (child) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        })
    )
  );
}

async function main() {
  const python = findPython();
  const [httpPort, wsPort] = await Promise.all([reservePort(), reservePort()]);
  const http = start(process.execPath, ["server.js", "--host", "127.0.0.1", "--port", String(httpPort), "--proxy-unknown", "0", "--db-enabled", "0"]);

  const healthResponse = await waitForHttp(
    `http://127.0.0.1:${httpPort}/__afk/health`,
    http
  );
  const health = await healthResponse.json();
  if (!health.ok || health.db.enabled) {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }

  const diamond = await postJson(
    `http://127.0.0.1:${httpPort}/__afk/control/diamond`,
    { diamond: 12345 }
  );
  if (diamond.forcedDiamond !== 12345) {
    throw new Error(`Diamond state mismatch: ${JSON.stringify(diamond)}`);
  }
  await postJson(`http://127.0.0.1:${httpPort}/__afk/control/diamond`, {
    enabled: false,
  });

  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const accountDetailResponse = await fetch(`${baseUrl}/api/sdk/account/user`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      app_uid: "180945015752192",
      app_token: "local-ticket-integration",
      type: "all",
    }),
  });
  const accountDetail = await accountDetailResponse.json();
  if (
    accountDetailResponse.status !== 200 ||
    accountDetail?.result?.code !== 0 ||
    !Array.isArray(accountDetail?.data?.binding_types) ||
    !Array.isArray(accountDetail?.data?.third_bindings)
  ) {
    throw new Error(`SDK account detail failed: ${JSON.stringify(accountDetail)}`);
  }
  console.log("SDK account detail direct route validation ok");

  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "diamond",
    quantity: 1000,
    extra: { source: "integration_test" },
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "item_13",
    quantity: 3,
    extra: { source: "integration_test", asset_type: "item", asset_id: 13 },
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "stage_ticket",
    quantity: 7,
    extra: { source: "integration_test" },
  });
  await postJson(`${baseUrl}/__afk/db/characters`, {
    character_id: "smoke_hero",
    level: 42,
    star: 3,
    extra: { source: "integration_test" },
  });
  await postJson(`${baseUrl}/__afk/db/characters`, {
    character_id: "1",
    level: 10,
    star: 1,
    extra: { hero_id: 1, tid: 22 },
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "item_1",
    quantity: 20,
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "gold",
    quantity: 5000,
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "hero_exp",
    quantity: 1000,
  });
  await postJson(`${baseUrl}/__afk/db/stages`, {
    stage_id: "smoke_stage",
    cleared: true,
    best_result_json: { stars: 3 },
  });
  const stateResponse = await fetch(`${baseUrl}/__afk/db/business-state`);
  const businessState = await stateResponse.json();
  const ticket = businessState.inventory.find((item) => item.item_id === "stage_ticket");
  const hero = businessState.characters.find(
    (character) => character.character_id === "smoke_hero"
  );
  const stage = businessState.stages.find((item) => item.stage_id === "smoke_stage");
  if (ticket?.quantity !== 7 || hero?.level !== 42 || !stage) {
    throw new Error(`Business-state round trip failed: ${JSON.stringify(businessState)}`);
  }
  console.log("HTTP health and business-state round trip validation ok");

  const upgrade = await postJson(`${baseUrl}/__afk/game/heroes/upgrade`, {
    hero_id: 1,
    up_level: 1,
  });
  const upgradedHero = upgrade.businessState.characters.find(
    (character) => character.character_id === "1"
  );
  const upgradedAssets = Object.fromEntries(
    upgrade.businessState.inventory.map((item) => [item.item_id, item.quantity])
  );
  if (
    upgradedHero?.level !== 11 ||
    upgradedHero?.extra_json?.gs !== 1110 ||
    upgradedAssets.item_1 !== 10 ||
    upgradedAssets.gold !== 3884 ||
    upgradedAssets.hero_exp !== 583 ||
    upgradedAssets.meta_daily_todo_4 !== 30 ||
    upgradedAssets.meta_line_task_18_1 !== 1
  ) {
    throw new Error(`Official hero upgrade transition failed: ${JSON.stringify(upgrade)}`);
  }
  console.log("official hero level 10 -> 11 transition validation ok");

  const taskClaim = await postJson(`${baseUrl}/__afk/game/tasks/batch-claim`, {
    ids: [1, 4, 5, 6],
  });
  const claimedTaskIds = taskClaim.reply_task?.batch_todo_reward?.ids;
  const taskMarkers = taskClaim.businessState.inventory.filter((item) =>
    item.item_id.startsWith("meta_task_claim_")
  );
  if (JSON.stringify(claimedTaskIds) !== "[1,4,5,6]" || taskMarkers.length !== 4) {
    throw new Error(`Task batch claim failed: ${JSON.stringify(taskClaim)}`);
  }
  console.log("captured task batch claim transaction validation ok");

  const taskInfo = await postJson(`${baseUrl}/__afk/game/action`, { op: "task_info" });
  const shop = await postJson(`${baseUrl}/__afk/game/action`, { op: "shop_open", shop_id: 2 });
  const mail = await postJson(`${baseUrl}/__afk/game/action`, { op: "mail_list" });
  const tower = await postJson(`${baseUrl}/__afk/game/action`, { op: "tower_win" });
  const arena = await postJson(`${baseUrl}/__afk/game/action`, { op: "arena_challenge", victory: true });
  const maze = await postJson(`${baseUrl}/__afk/game/action`, { op: "maze_move", cell_id: 2 });
  const guild = await postJson(`${baseUrl}/__afk/game/action`, { op: "guild_join", guild_id: 1 });
  if (
    taskInfo.task_info?.daily_point !== 100 ||
    shop.goods?.length !== 16 ||
    mail.mails?.length !== 2 ||
    tower.floor_id !== 2 ||
    arena.point !== 1010 ||
    maze.cell_id !== 2 ||
    guild.guild_id !== 1
  ) {
    throw new Error(`Core systems HTTP loop failed: ${JSON.stringify({ taskInfo, shop, mail, tower, arena, maze, guild })}`);
  }
  console.log("task/shop/mail/tower/arena/maze/guild state transitions ok");

  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "item_13",
    quantity: 3,
    extra: { source: "integration_tavern_api_seed" },
  });
  const tavernApi = await postJson(`${baseUrl}/__afk/game/tavern/draw`, {
    tavern_id: 1,
    count: 1,
  });
  const tavernApiTicket = tavernApi.businessState.inventory.find(
    (item) => item.item_id === "item_13"
  );
  const tavernApiHero = tavernApi.businessState.characters.find(
    (character) => character.character_id === "tavern_hero_1005"
  );
  const tavernApiAssets = Object.fromEntries(
    tavernApi.businessState.inventory.map((item) => [item.item_id, item.quantity])
  );
  if (
    tavernApi.evidence_level !== "captured_single_draw" ||
    tavernApiTicket?.quantity !== 2 ||
    tavernApiAssets.meta_daily_todo_6 !== 2 ||
    tavernApiAssets.meta_weekly_todo_105 !== 2 ||
    !tavernApiHero
  ) {
    throw new Error(`Tavern HTTP transaction failed: ${JSON.stringify(tavernApi)}`);
  }
  const altar = await postJson(`${baseUrl}/__afk/game/action`, {
    op: "altar_disband",
    hero_ids: [1005, 9999],
  });
  if (
    !altar.ok ||
    altar.remove_characters?.[0] !== "tavern_hero_1005" ||
    altar.businessState.characters.some((character) => character.character_id === "tavern_hero_1005")
  ) {
    throw new Error(`Altar disband transaction failed: ${JSON.stringify(altar)}`);
  }
  console.log("tavern-to-altar duplicate conversion validation ok");
  await postJson(`${baseUrl}/__afk/db/inventory`, {
    item_id: "item_13",
    quantity: 20,
    extra: { source: "integration_ws_tavern_seed" },
  });
  await postJson(`${baseUrl}/__afk/db/characters`, {
    character_id: "1",
    level: 10,
    star: 1,
    extra: { hero_id: 1, tid: 22, quality: 1, rank: 2, gs: 997 },
  });
  await postJson(`${baseUrl}/__afk/db/inventory`, { item_id: "item_1", quantity: 20 });
  await postJson(`${baseUrl}/__afk/db/inventory`, { item_id: "diamond", quantity: 1000 });
  await postJson(`${baseUrl}/__afk/db/inventory`, { item_id: "gold", quantity: 5000 });
  await postJson(`${baseUrl}/__afk/db/inventory`, { item_id: "hero_exp", quantity: 1000 });
  console.log("captured tavern HTTP transaction validation ok");

  const wsLog = path.join(
    os.tmpdir(),
    `afk-ws-smoke-${process.pid}-${Date.now()}.jsonl`
  );
  const ws = start(
    python,
    [
      "websocket_proxy.py",
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(wsPort),
      "--log-file",
      wsLog,
      "--structured-login-fixture",
      path.join(ROOT, "data", "fixtures", "ws-login-timeline-1.json"),
      "--interaction-fixture",
      path.join(ROOT, "data", "fixtures", "ws-interactions-stage-battle-1.json"),
      "--no-mysql",
      "--no-login-mysql",
    ],
    {
      AFK_MOCK_INTERNAL_BASE_URL: baseUrl,
    }
  );
  await waitForOutput(/WebSocket proxy listening on/, ws);
  await run(python, [
    "validate_structured_interaction.py",
    "--url",
    `ws://127.0.0.1:${wsPort}`,
  ]);
  const postDrawResponse = await fetch(`${baseUrl}/__afk/db/business-state`);
  const postDrawState = await postDrawResponse.json();
  const postDrawTicket = postDrawState.inventory.find(
    (item) => item.item_id === "item_13"
  );
  const postDrawDiamond = postDrawState.inventory.find(
    (item) => item.item_id === "diamond"
  );
  const drawnHero = postDrawState.characters.find(
    (character) => character.character_id === "tavern_hero_1005"
  );
  const wsUpgradedHero = postDrawState.characters.find(
    (character) => character.character_id === "1"
  );
  const wsAssets = Object.fromEntries(
    postDrawState.inventory.map((item) => [item.item_id, item.quantity])
  );
  if (
    postDrawTicket?.quantity !== 9 ||
    postDrawDiamond?.quantity !== 1000 ||
    !drawnHero ||
    wsUpgradedHero?.level !== 11 ||
    wsAssets.item_1 !== 10 ||
    wsAssets.gold !== 3884 ||
    wsAssets.hero_exp !== 583 ||
    wsAssets.meta_daily_todo_4 !== 30 ||
    wsAssets.meta_line_task_18_1 !== 1 ||
    wsAssets.meta_daily_todo_6 !== 2 ||
    wsAssets.meta_weekly_todo_105 !== 2
  ) {
    throw new Error(`Tavern state transition failed: ${JSON.stringify(postDrawState)}`);
  }
  console.log("tavern single/ten draw and hero upgrade websocket transactions persisted");
  const wsRecords = fs.readFileSync(wsLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const dbAssistReplies = wsRecords.filter(
    (record) => record.event === "frame" && record.fixture_label === "db_stage_assist_summaries"
  );
  if (dbAssistReplies.length !== 2) {
    throw new Error(`Expected two repeatable DB assist replies, got ${dbAssistReplies.length}`);
  }
  console.log("repeated stage assist queries used current DB state");
  fs.rmSync(wsLog, { force: true });
}

main()
  .then(async () => {
    await stopAll();
    console.log("integration smoke test ok");
  })
  .catch(async (error) => {
    await stopAll();
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
