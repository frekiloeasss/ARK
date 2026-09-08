CREATE TABLE IF NOT EXISTS kv_state (
  state_key VARCHAR(128) NOT NULL,
  state_value JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (state_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider VARCHAR(64) NOT NULL DEFAULT 'local',
  provider_uid VARCHAR(191) NOT NULL,
  display_name VARCHAR(191) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_provider_uid (provider, provider_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NULL,
  session_token VARCHAR(191) NOT NULL,
  last_ticketid VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  client_ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token (session_token),
  KEY idx_sessions_account_id (account_id),
  CONSTRAINT fk_sessions_account_id FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS players (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NULL,
  player_uid VARCHAR(191) NOT NULL,
  nickname VARCHAR(191) NULL,
  level INT UNSIGNED NOT NULL DEFAULT 1,
  exp BIGINT UNSIGNED NOT NULL DEFAULT 0,
  gold BIGINT UNSIGNED NOT NULL DEFAULT 0,
  diamond BIGINT UNSIGNED NOT NULL DEFAULT 0,
  profile_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_players_uid (player_uid),
  KEY idx_players_account_id (account_id),
  CONSTRAINT fk_players_account_id FOREIGN KEY (account_id) REFERENCES accounts (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  item_id VARCHAR(128) NOT NULL,
  quantity BIGINT UNSIGNED NOT NULL DEFAULT 0,
  extra_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_player_item (player_id, item_id),
  CONSTRAINT fk_inventory_player_id FOREIGN KEY (player_id) REFERENCES players (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS characters (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  character_id VARCHAR(128) NOT NULL,
  level INT UNSIGNED NOT NULL DEFAULT 1,
  star INT UNSIGNED NOT NULL DEFAULT 0,
  extra_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_characters_player_character (player_id, character_id),
  CONSTRAINT fk_characters_player_id FOREIGN KEY (player_id) REFERENCES players (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stage_progress (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  stage_id VARCHAR(128) NOT NULL,
  best_result_json JSON NULL,
  cleared_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stage_progress_player_stage (player_id, stage_id),
  CONSTRAINT fk_stage_progress_player_id FOREIGN KEY (player_id) REFERENCES players (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NULL,
  channel VARCHAR(64) NOT NULL DEFAULT 'world',
  message TEXT NOT NULL,
  payload_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_chat_messages_player_id (player_id),
  KEY idx_chat_messages_channel_created_at (channel, created_at),
  CONSTRAINT fk_chat_messages_player_id FOREIGN KEY (player_id) REFERENCES players (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS request_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id CHAR(36) NOT NULL,
  time DATETIME(3) NOT NULL,
  method VARCHAR(16) NOT NULL,
  local_path VARCHAR(512) NOT NULL,
  local_query TEXT NULL,
  original_host VARCHAR(255) NULL,
  original_scheme VARCHAR(16) NULL,
  action VARCHAR(64) NULL,
  upstream_url TEXT NULL,
  status_code INT NULL,
  duration_ms INT NULL,
  request_body_preview MEDIUMBLOB NULL,
  response_body_preview MEDIUMBLOB NULL,
  record_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_request_logs_request_id (request_id),
  KEY idx_request_logs_time (time),
  KEY idx_request_logs_path (local_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ws_frame_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  time DATETIME(3) NULL,
  session_id VARCHAR(128) NULL,
  direction VARCHAR(32) NULL,
  opcode VARCHAR(32) NULL,
  route VARCHAR(255) NULL,
  sequence_id BIGINT NULL,
  payload_preview MEDIUMBLOB NULL,
  frame_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ws_frame_logs_session_id (session_id),
  KEY idx_ws_frame_logs_route (route),
  KEY idx_ws_frame_logs_time (time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ws_interaction_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_name VARCHAR(191) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 100,
  request_signature JSON NOT NULL,
  response_sequence JSON NOT NULL,
  source_fixture VARCHAR(512) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ws_interaction_rules_enabled_priority (enabled, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS local_credentials (
  account_id BIGINT UNSIGNED NOT NULL,
  password_salt CHAR(32) NOT NULL,
  password_hash CHAR(128) NOT NULL,
  sdk_password_hash CHAR(32) NULL,
  role ENUM('player','gm','admin') NOT NULL DEFAULT 'player',
  banned_until TIMESTAMP NULL,
  ban_reason VARCHAR(512) NULL,
  last_login_at TIMESTAMP NULL,
  PRIMARY KEY (account_id),
  CONSTRAINT fk_local_credentials_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gm_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  gm_account_id BIGINT UNSIGNED NULL,
  action VARCHAR(128) NOT NULL,
  target_player_id BIGINT UNSIGNED NULL,
  payload_json JSON NULL,
  result_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gm_audit_created (created_at),
  CONSTRAINT fk_gm_audit_account FOREIGN KEY (gm_account_id) REFERENCES accounts (id) ON DELETE SET NULL,
  CONSTRAINT fk_gm_audit_player FOREIGN KEY (target_player_id) REFERENCES players (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS battle_records (
  id CHAR(36) NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  mode VARCHAR(32) NOT NULL,
  stage_id BIGINT UNSIGNED NOT NULL,
  seed BIGINT UNSIGNED NOT NULL,
  lineup_json JSON NOT NULL,
  simulation_json JSON NOT NULL,
  server_result ENUM('victory','defeat') NOT NULL,
  client_result ENUM('victory','defeat') NULL,
  verified TINYINT(1) NULL,
  status ENUM('active','finished','expired') NOT NULL DEFAULT 'active',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_battle_player_status (player_id, status, started_at),
  CONSTRAINT fk_battle_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS battle_settlements (
  battle_id CHAR(36) NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  request_key VARCHAR(191) NOT NULL,
  client_result ENUM('victory','defeat') NULL,
  authoritative_result ENUM('victory','defeat') NOT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  response_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (battle_id),
  UNIQUE KEY uq_battle_settlement_request (player_id, request_key),
  KEY idx_battle_settlement_player_created (player_id, created_at),
  CONSTRAINT fk_battle_settlement_battle FOREIGN KEY (battle_id) REFERENCES battle_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_battle_settlement_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_mails (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  sender VARCHAR(191) NOT NULL DEFAULT '系统',
  title VARCHAR(191) NOT NULL,
  body TEXT NULL,
  assets_json JSON NULL,
  read_at TIMESTAMP NULL,
  received_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_player_mails_player_created (player_id, created_at),
  CONSTRAINT fk_player_mails_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS friendships (
  player_id BIGINT UNSIGNED NOT NULL,
  friend_player_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','accepted','blocked') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, friend_player_id),
  CONSTRAINT fk_friendships_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_friendships_friend FOREIGN KEY (friend_player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS social_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  recipient_player_id BIGINT UNSIGNED NOT NULL,
  actor_player_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  read_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_social_events_recipient_unread (recipient_player_id, read_at, id),
  CONSTRAINT fk_social_event_recipient FOREIGN KEY (recipient_player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_social_event_actor FOREIGN KEY (actor_player_id) REFERENCES players (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS friend_gifts (
  sender_player_id BIGINT UNSIGNED NOT NULL,
  recipient_player_id BIGINT UNSIGNED NOT NULL,
  period_day BIGINT NOT NULL,
  received_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sender_player_id, recipient_player_id, period_day),
  KEY idx_friend_gifts_recipient (recipient_player_id, received_at, period_day),
  CONSTRAINT fk_friend_gift_sender FOREIGN KEY (sender_player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_friend_gift_recipient FOREIGN KEY (recipient_player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mercenary_offers (
  owner_player_id BIGINT UNSIGNED NOT NULL,
  hero_id VARCHAR(191) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_player_id, hero_id),
  KEY idx_mercenary_offers_active (active, updated_at),
  CONSTRAINT fk_mercenary_offer_owner FOREIGN KEY (owner_player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mercenary_loans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_player_id BIGINT UNSIGNED NOT NULL,
  borrower_player_id BIGINT UNSIGNED NOT NULL,
  hero_id VARCHAR(191) NOT NULL,
  period_week BIGINT NOT NULL,
  status ENUM('pending','active','used','returned','rejected','cancelled') NOT NULL DEFAULT 'pending',
  uses INT UNSIGNED NOT NULL DEFAULT 0,
  max_uses INT UNSIGNED NOT NULL DEFAULT 1,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at TIMESTAMP NULL,
  returned_at TIMESTAMP NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mercenary_weekly_request (borrower_player_id, owner_player_id, hero_id, period_week),
  KEY idx_mercenary_owner_status (owner_player_id, status, updated_at),
  KEY idx_mercenary_borrower_status (borrower_player_id, status, updated_at),
  CONSTRAINT fk_mercenary_loan_owner FOREIGN KEY (owner_player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_mercenary_loan_borrower FOREIGN KEY (borrower_player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mercenary_battle_uses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  loan_id BIGINT UNSIGNED NOT NULL,
  borrower_player_id BIGINT UNSIGNED NOT NULL,
  request_key VARCHAR(191) NOT NULL,
  battle_id VARCHAR(191) NULL,
  battle_mode VARCHAR(64) NOT NULL DEFAULT 'campaign',
  result ENUM('started','victory','defeat') NOT NULL DEFAULT 'started',
  settled_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mercenary_battle_request (borrower_player_id, request_key),
  KEY idx_mercenary_battle_loan (loan_id, created_at),
  CONSTRAINT fk_mercenary_battle_loan FOREIGN KEY (loan_id) REFERENCES mercenary_loans (id) ON DELETE CASCADE,
  CONSTRAINT fk_mercenary_battle_borrower FOREIGN KEY (borrower_player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS server_jobs (
  job_name VARCHAR(128) NOT NULL,
  last_run_at TIMESTAMP NULL,
  next_run_at TIMESTAMP NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  result_json JSON NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (job_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_system_state (
  player_id BIGINT UNSIGNED NOT NULL,
  module_name VARCHAR(96) NOT NULL,
  state_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, module_name),
  CONSTRAINT fk_system_state_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS system_action_receipts (
  player_id BIGINT UNSIGNED NOT NULL,
  module_name VARCHAR(96) NOT NULL,
  request_key VARCHAR(191) NOT NULL,
  response_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, module_name, request_key),
  CONSTRAINT fk_system_receipt_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS liveops_instances (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  activity_key VARCHAR(128) NOT NULL,
  config_table VARCHAR(128) NULL,
  title VARCHAR(191) NOT NULL,
  starts_at TIMESTAMP NOT NULL,
  ends_at TIMESTAMP NOT NULL,
  claim_ends_at TIMESTAMP NULL,
  status ENUM('draft','active','paused','ended') NOT NULL DEFAULT 'draft',
  rules_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_liveops_activity_key (activity_key),
  KEY idx_liveops_window (status, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS player_activity_progress (
  player_id BIGINT UNSIGNED NOT NULL,
  liveops_instance_id BIGINT UNSIGNED NOT NULL,
  state_json JSON NOT NULL,
  version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, liveops_instance_id),
  CONSTRAINT fk_activity_progress_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_activity_progress_instance FOREIGN KEY (liveops_instance_id) REFERENCES liveops_instances (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_orders (
  id CHAR(36) NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  sku VARCHAR(128) NOT NULL,
  amount_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  status ENUM('created','paid','fulfilled','cancelled','refunded') NOT NULL DEFAULT 'created',
  provider VARCHAR(32) NOT NULL DEFAULT 'sandbox',
  idempotency_key VARCHAR(191) NOT NULL,
  request_json JSON NULL,
  receipt_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TIMESTAMP NULL,
  fulfilled_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_idempotency (idempotency_key),
  KEY idx_payment_player_created (player_id, created_at),
  CONSTRAINT fk_payment_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_entitlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id CHAR(36) NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  entitlement_key VARCHAR(128) NOT NULL,
  amount BIGINT UNSIGNED NOT NULL DEFAULT 1,
  payload_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_order_entitlement (order_id, entitlement_key),
  CONSTRAINT fk_entitlement_order FOREIGN KEY (order_id) REFERENCES payment_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_entitlement_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ranking_entries (
  board_key VARCHAR(96) NOT NULL,
  season_key VARCHAR(96) NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  score BIGINT NOT NULL DEFAULT 0,
  detail_json JSON NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (board_key, season_key, player_id),
  KEY idx_ranking_lookup (board_key, season_key, score),
  CONSTRAINT fk_ranking_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_guilds (
  guild_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(191) NOT NULL,
  level INT UNSIGNED NOT NULL DEFAULT 1,
  notice VARCHAR(512) NULL,
  capacity INT UNSIGNED NOT NULL DEFAULT 70,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_profiles (
  bot_id BIGINT UNSIGNED NOT NULL,
  nickname VARCHAR(191) NOT NULL,
  level INT UNSIGNED NOT NULL DEFAULT 1,
  avatar VARCHAR(191) NULL,
  guild_id BIGINT UNSIGNED NULL,
  power BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rating BIGINT UNSIGNED NOT NULL DEFAULT 1000,
  lineup_json JSON NOT NULL,
  personality_json JSON NOT NULL,
  last_active_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (bot_id),
  KEY idx_bot_rating (rating),
  KEY idx_bot_guild (guild_id),
  CONSTRAINT fk_bot_guild FOREIGN KEY (guild_id) REFERENCES bot_guilds (guild_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_battle_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  player_id BIGINT UNSIGNED NOT NULL,
  bot_id BIGINT UNSIGNED NOT NULL,
  result ENUM('victory','defeat') NOT NULL,
  point_change INT NOT NULL DEFAULT 0,
  replay_id VARCHAR(64) NOT NULL,
  detail_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_bot_battle_player (player_id,created_at),
  CONSTRAINT fk_bot_battle_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_bot_battle_profile FOREIGN KEY (bot_id) REFERENCES bot_profiles (bot_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_friendships (
  player_id BIGINT UNSIGNED NOT NULL,
  bot_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','accepted','blocked') NOT NULL DEFAULT 'accepted',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id,bot_id),
  CONSTRAINT fk_bot_friend_player FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE,
  CONSTRAINT fk_bot_friend_profile FOREIGN KEY (bot_id) REFERENCES bot_profiles (bot_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS security_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  event_type VARCHAR(96) NOT NULL,
  actor VARCHAR(191) NULL,
  remote_ip VARCHAR(64) NULL,
  payload_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_security_event_created (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS resource_manifests (
  manifest_key VARCHAR(128) NOT NULL,
  root_path VARCHAR(1024) NOT NULL,
  file_count BIGINT UNSIGNED NOT NULL,
  total_bytes BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  manifest_json JSON NOT NULL,
  verified_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (manifest_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
