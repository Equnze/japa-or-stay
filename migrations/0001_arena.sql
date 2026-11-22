-- Japa or Stay: Challenge Arena — first database migration (Cloudflare D1 / SQLite).
-- Additive only: the single-player game keeps no data on the server, so nothing existing is touched.
-- Apply with: npx wrangler d1 migrations apply japa-arena --remote
-- Times are milliseconds since 1970 (UTC), always set by the server.

PRAGMA foreign_keys = ON;

-- Players are anonymous: a random id and a secret token held on the device. Only hashes of secrets are stored.
CREATE TABLE players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  recovery_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_json TEXT NOT NULL DEFAULT '{}',
  title TEXT NOT NULL DEFAULT 'boss' CHECK (title IN ('king', 'queen', 'boss')),
  privacy TEXT NOT NULL DEFAULT 'members' CHECK (privacy IN ('public', 'members', 'private')),
  friend_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  host_id TEXT NOT NULL REFERENCES players(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'active', 'complete', 'cancelled')),
  rules_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  current_week INTEGER NOT NULL DEFAULT 0,
  week_started_at INTEGER,
  week_deadline_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  rematch_of TEXT REFERENCES rooms(id),
  version INTEGER NOT NULL DEFAULT 1,          -- bumps on every change members should see (cheap "has anything changed?" polling)
  created_at INTEGER NOT NULL
);
CREATE INDEX rooms_host ON rooms(host_id);
CREATE INDEX rooms_public ON rooms(visibility, status);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'joined', 'removed', 'left', 'declined')),
  ready INTEGER NOT NULL DEFAULT 0,
  character_json TEXT,
  joined_at INTEGER NOT NULL,
  UNIQUE (room_id, player_id)
);
CREATE INDEX participants_player ON participants(player_id, status);

-- The authoritative game state of each player in a room. Only the server's turn replay writes it.
CREATE TABLE char_states (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  state_json TEXT NOT NULL,
  state_version INTEGER NOT NULL DEFAULT 0,
  week INTEGER NOT NULL,          -- competition week the turn counter belongs to
  turns_used INTEGER NOT NULL DEFAULT 0,
  story_done INTEGER NOT NULL DEFAULT 0,
  opening_json TEXT NOT NULL,     -- the opening measures, used as "last week" for week 1
  updated_at INTEGER NOT NULL
);
CREATE INDEX char_states_room ON char_states(room_id);

-- Every accepted turn. UNIQUE(participant, week, turn) makes a second write of the same turn impossible.
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  op_id TEXT NOT NULL UNIQUE,
  decisions_json TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  rules_version TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  stats_json TEXT NOT NULL,       -- the six life stats after the turn
  cash_before INTEGER NOT NULL,
  cash_after INTEGER NOT NULL,
  game_week INTEGER NOT NULL,     -- the in-game week number after the turn
  created_at INTEGER NOT NULL,
  UNIQUE (participant_id, week, turn)
);
CREATE INDEX turns_room_week ON turns(room_id, week);

-- Financial ledger, derived from the server's own replay. Lines for a turn always add up to cash_after - cash_before.
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  amount INTEGER NOT NULL,        -- in naira at the competition rate
  currency TEXT NOT NULL,         -- the currency the line happened in (NGN or USD)
  original_amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_participant ON ledger(participant_id, week, turn);

CREATE TABLE weeks (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'final')),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  finalized_at INTEGER,
  rules_version TEXT NOT NULL,
  highlights_json TEXT,
  PRIMARY KEY (room_id, week)
);

-- Official weekly results: written once, never updated (INSERT OR IGNORE keeps a retry from changing anything).
CREATE TABLE week_results (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  rank_money INTEGER NOT NULL,
  eligible_cash INTEGER NOT NULL,
  net_worth INTEGER NOT NULL,
  life_balance REAL NOT NULL,
  metrics_json TEXT NOT NULL,
  deltas_json TEXT NOT NULL,
  ranks_json TEXT NOT NULL,
  cum_json TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, week, participant_id)
);

CREATE TABLE week_awards (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  award_key TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  value REAL NOT NULL,
  PRIMARY KEY (room_id, week, award_key, participant_id)
);
CREATE INDEX week_awards_participant ON week_awards(participant_id);

-- One row per player per achievement, ever.
CREATE TABLE achievements (
  player_id TEXT NOT NULL REFERENCES players(id),
  key TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, key)
);

-- Friends: one row per pair, with the smaller id first.
CREATE TABLE friends (
  a_id TEXT NOT NULL REFERENCES players(id),
  b_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  requested_by TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX friends_b ON friends(b_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  from_id TEXT NOT NULL REFERENCES players(id),
  to_id TEXT NOT NULL REFERENCES players(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, to_id)
);
CREATE INDEX invitations_to ON invitations(to_id, status);

-- Reactions use a fixed set of emoji, so there is no free text to moderate.
CREATE TABLE reactions (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  week INTEGER NOT NULL,
  from_id TEXT NOT NULL REFERENCES players(id),
  to_participant TEXT NOT NULL REFERENCES participants(id),
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, week, from_id, to_participant)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,            -- deterministic ids (for example room:week:player:results) so retries never duplicate
  player_id TEXT NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL,
  room_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_player ON notifications(player_id, read, created_at);

-- Every sync operation the server has seen, accepted or not: the audit trail for offline play and the idempotency key.
CREATE TABLE sync_ops (
  op_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  room_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason TEXT,
  received_at INTEGER NOT NULL,
  result_json TEXT
);
CREATE INDEX sync_ops_player ON sync_ops(player_id, received_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  room_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_room ON audit_log(room_id, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL CHECK (kind IN ('player', 'room')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (reporter_id, kind, target_id)
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
