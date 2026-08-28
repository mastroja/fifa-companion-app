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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- One-way switch: once set to 1 for a save it is never set back to 0
    -- (see enableYouthMode in main.js) — "always activated" per the user's
    -- design for Youth Squad Career Mode.
    youth_mode_enabled INTEGER DEFAULT 0
);

-- Seasons table (one row per season per save)
CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id INTEGER NOT NULL,
    year_label TEXT NOT NULL,       -- e.g. "2026/2027"
    is_current INTEGER DEFAULT 0,   -- 1 = the season currently being written to
    -- The primary domestic league's real name for this season (e.g.
    -- "Premier League", "Championship") — a save can change league across
    -- seasons via promotion/relegation, so this can't just live on saves.
    -- Set from export_all.lua's LEAGUE STATS EXPORT (see persistLeagueStats
    -- in main.js), updated on every sync while this is the current season.
    league_name TEXT,
    -- 1 once the End of Season Overview splash for the season THAT
    -- FOLLOWED this one has been shown and dismissed — tracked on the
    -- season that just ENDED, not the new one, since the overview reviews
    -- the ended season. See getPendingSeasonOverview in main.js.
    overview_acknowledged INTEGER DEFAULT 0,
    FOREIGN KEY(save_id) REFERENCES saves(id),
    UNIQUE(save_id, year_label)
);

-- One row per save, upserted on every calendar sync. Backs the Home
-- dashboard's "live" widgets (standings, upcoming match, captain,
-- manager, trophies) when browsing a save that isn't the one currently
-- loaded in Live Editor — that data only ever exists live, so this is
-- the last-known snapshot instead of nothing.
CREATE TABLE IF NOT EXISTS save_snapshots (
    save_id INTEGER PRIMARY KEY,
    raw_calendar_json TEXT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(save_id) REFERENCES saves(id)
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

    -- change since the previous sync (not cumulative for the season) —
    -- see computeAttributeDeltas in main.js
    overall_delta INTEGER DEFAULT 0,
    attribute_deltas_json TEXT,

    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(player_id, season_id)
);

-- Completed match results, accumulated season by season as the calendar
-- export syncs. Live Editor's export only ever contains the *current*
-- season's fixtures, so this is the only place multi-season match
-- history (needed for the Manager PPG-by-season widget) lives.
CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    match_date TEXT,
    competition TEXT,
    opponent TEXT,
    is_home INTEGER,
    user_score INTEGER,
    opponent_score INTEGER,
    result TEXT, -- 'W' / 'D' / 'L'
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id, match_date, opponent, competition)
);

-- Per-competition standing/progress, upserted every calendar sync from
-- the same fixture-aggregation the calendar export's "competitions"
-- array already computes (see export_all.lua). Never overwritten across
-- seasons (only within the current one), same accumulation pattern as
-- player_season_stats/matches — this is what lets Team Record show
-- "place finished" for past seasons, not just the live one.
-- Youth academy roster, upserted per season like player_season_stats.
-- Never deleted once a player_id has appeared here for a save — this is
-- what lets us detect "Academy Graduate" in getInferredTransfers (a
-- player who newly appears on the senior squad and was previously seen
-- here, rather than a real signing).
CREATE TABLE IF NOT EXISTS youth_academy_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    season_id INTEGER NOT NULL,
    tier INTEGER,
    months_in_squad INTEGER,
    overall INTEGER,
    potential_low INTEGER,
    potential_high INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(player_id, season_id)
);

-- League-wide (not just our own squad) per-player stats, upserted every
-- league-stats sync exactly like player_season_stats is for our own
-- squad — this is what makes the League Stats tab's season selector
-- possible: a past season's leaderboard is already fully captured by the
-- time it ends, rather than needing a separate "snapshot on rollover"
-- step that could race with the season actually changing. See
-- persistLeagueStats in main.js and export_all.lua's LEAGUE STATS EXPORT.
CREATE TABLE IF NOT EXISTS season_league_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    name TEXT,
    team_name TEXT,
    overall INTEGER,
    position_id INTEGER,
    dob TEXT,
    appearances INTEGER,
    goals INTEGER,
    assists INTEGER,
    clean_sheets INTEGER,
    yellow_cards INTEGER,
    red_cards INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id, player_id)
);

-- Every team's row in the primary league table, upserted every calendar
-- sync exactly like season_league_stats — same reasoning: a season's
-- full table is already captured by the time it ends. Rank isn't stored
-- (computed on read, sorted by points/GD/GF) since it shifts as more
-- fixtures complete within the same season. See persistSeasonStandings
-- in main.js and the calendar export's "standings" array.
CREATE TABLE IF NOT EXISTS season_standings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    team_name TEXT,
    played INTEGER,
    wins INTEGER,
    draws INTEGER,
    losses INTEGER,
    goals_for INTEGER,
    goals_against INTEGER,
    points INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id, team_id)
);

CREATE TABLE IF NOT EXISTS season_competition_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id INTEGER NOT NULL,
    comp_name TEXT NOT NULL,
    standing TEXT,          -- e.g. "5th of 20 — 62 pts" or "W3 D1 L2"
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id, comp_name)
);

-- Youth Squad Career Mode: one row per season that ended with more
-- players over the league's overall-rating cap than the tier allows (see
-- generateSeasonEndReviewIfNeeded in main.js). Only created for saves with
-- youth_mode_enabled = 1, and only when there's actually a violation to
-- surface — the end-of-season popup reads whatever's unacknowledged for
-- the active save. UNIQUE(season_id) means each season is only ever
-- evaluated once, right when the next season starts.
-- Individual season-end awards (Golden Boot / Playmaker / Golden Glove) —
-- one row per season per award, only for players who were the league-wide
-- leader in that category AND on our own squad that season. See
-- generateSeasonAwardsIfNeeded in main.js. UNIQUE(season_id, award_type)
-- means only one recipient per award per season (ties broken by whichever
-- the league-wide stats list happened to sort first).
CREATE TABLE IF NOT EXISTS player_awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    season_id INTEGER NOT NULL,
    award_type TEXT NOT NULL,   -- 'golden_boot' | 'playmaker' | 'golden_glove'
    stat_value INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id, award_type)
);

CREATE TABLE IF NOT EXISTS season_end_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id INTEGER NOT NULL,
    season_id INTEGER NOT NULL,
    league_name TEXT,
    league_tier INTEGER,
    league_average_overall INTEGER,
    league_average_margin INTEGER,
    allowed_overrated_count INTEGER,
    overrated_count INTEGER,
    overrated_players_json TEXT,
    acknowledged INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(save_id) REFERENCES saves(id),
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(season_id)
);