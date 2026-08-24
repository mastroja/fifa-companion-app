-- ============================================================
-- EA FC Career Companion — schema
-- One row per player per season in player_season_stats is what
-- makes multi-season history possible. Never DROP these tables
-- on app launch — only CREATE TABLE IF NOT EXISTS.
-- ============================================================

-- Saves table (supports multiple Career Mode saves/careers)
CREATE TABLE IF NOT EXISTS saves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manager_name TEXT,
    club_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seasons table (one row per season per save)
CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id INTEGER NOT NULL,
    year_label TEXT NOT NULL,       -- e.g. "2026/2027"
    is_current INTEGER DEFAULT 0,   -- 1 = the season currently being written to
    FOREIGN KEY(save_id) REFERENCES saves(id),
    UNIQUE(save_id, year_label)
);

-- Master players table — bio / static info that rarely changes
CREATE TABLE IF NOT EXISTS players (
    player_id INTEGER PRIMARY KEY,  -- matches EA FC internal playerid
    name TEXT NOT NULL,
    position_id INTEGER,
    nationality TEXT,
    dob TEXT,
    height TEXT,
    weight TEXT,
    preferred_foot TEXT,
    photo_id INTEGER
);

-- Seasonal player snapshots — the actual history table
CREATE TABLE IF NOT EXISTS player_season_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    season_id INTEGER NOT NULL,

    -- ratings
    overall INTEGER,
    potential INTEGER,
    skill_moves TEXT,
    weak_foot TEXT,

    -- club/contract status at time of snapshot
    club_id INTEGER,
    club_name TEXT,
    contract_expiry TEXT,
    contract_date TEXT,
    duration_months INTEGER,
    player_role_ INTEGER,
    last_status_change_date TEXT,
    on_loan INTEGER DEFAULT 0,
    loan_team_from INTEGER,
    loan_club_name TEXT,
    loan_date_end TEXT,
    is_loan_to_buy INTEGER DEFAULT 0,
    wage INTEGER,

    -- stats accumulated so far this season
    goals INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    appearances INTEGER DEFAULT 0,
    clean_sheets INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    yellow_cards INTEGER DEFAULT 0,
    red_cards INTEGER DEFAULT 0,
    avg_rating REAL DEFAULT 0.0,

    -- blobs for stuff we don't need to query on directly
    attributes_json TEXT,
    competitions_json TEXT,
    traits_json TEXT,
    play_styles_json TEXT,

    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(player_id, season_id)
);