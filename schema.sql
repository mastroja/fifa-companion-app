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
    youth_mode_enabled INTEGER DEFAULT 0,
    -- Set by clearFormerPlayers in main.js when the user clears the Former
    -- Players tab (e.g. right before starting a youth rebuild, to drop the
    -- pre-rebuild squad that shouldn't count). getPastPlayers hides anyone
    -- whose last known row predates this timestamp; it never touches the
    -- underlying player_season_stats rows, so past season stats/leaders
    -- are unaffected — only the Former Players list is filtered.
    former_players_cleared_before DATETIME
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
    -- Final Save Point (see checkSeasonFinalSavePoint in main.js): the
    -- most recent in-game date seen for this season (from the calendar
    -- export's current_date), used to detect the May-reminder and
    -- June 20-29 final-check windows without needing a fresh sync at the
    -- exact moment the app is opened.
    last_known_date TEXT,
    -- Set once, the first time the June 20-29 check finds this season's
    -- data genuinely complete (its primary league result is no longer
    -- "Not Started") — the season's own Season Summary is then frozen
    -- into final_save_point_overview_json and shown right away, BEFORE
    -- the in-game rollover, instead of waiting for it.
    final_save_point_at DATETIME,
    final_save_point_overview_json TEXT,
    -- Set once the last-week-of-May reminder toast has been shown and
    -- dismissed, so it doesn't reappear on every later sync/app open.
    final_reminder_may_shown_at DATETIME,
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
    -- Comma-separated position ids (same numbering as position_id) the
    -- player can also play, from EA's preferredposition2..6 fields —
    -- empty string if none are set. See export_all.lua/export_squad.lua.
    alt_positions TEXT,
    nationality TEXT,
    dob TEXT,
    height TEXT,
    weight TEXT,
    preferred_foot TEXT,
    photo_id INTEGER,
    -- Youth Squad Career Mode's potential-reveal mechanic: the England
    -- pyramid tier (1=Premier League ... 4=League Two, see
    -- YOUTH_MODE_PYRAMID_TIERS in main.js) the club was playing in the
    -- FIRST time this player was ever seen in player_season_stats — set
    -- once and never changed afterward (see importFifaData), so a
    -- player's reveal speed is locked to whatever scouting resources the
    -- club had at the moment they were promoted, even if the club is
    -- later promoted/relegated. NULL until Youth Mode is on and this
    -- player has synced at least once. See YOUTH_REVEAL_SCHEDULE_BY_TIER
    -- in index.html for what this actually controls.
    youth_reveal_tier INTEGER
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
    jersey_number INTEGER,
    injury INTEGER DEFAULT 0,

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

    -- Cumulative change for the WHOLE season so far, not just since the
    -- previous sync — computed by diffing the current overall/attributes
    -- against season_start_overall/season_start_attributes_json below,
    -- see computeAttributeDeltas and the sync logic in main.js.
    overall_delta INTEGER DEFAULT 0,
    attribute_deltas_json TEXT,

    -- Frozen snapshot of this player's overall/attributes from the FIRST
    -- sync of this season — set once on this row's initial insert and
    -- never touched again (deliberately excluded from every subsequent
    -- ON CONFLICT DO UPDATE), so overall_delta/attribute_deltas_json above
    -- always measure growth from the start of the season, not from
    -- whatever the last sync happened to be. A new season gets its own
    -- row (and its own fresh baseline) automatically via the
    -- UNIQUE(player_id, season_id) constraint below — no explicit
    -- "clear at season end" step needed.
    season_start_overall INTEGER,
    season_start_attributes_json TEXT,

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

-- Season-by-season tracking for players who've LEFT the club, so their
-- career keeps being followed for as long as the save continues instead
-- of freezing at whatever they were worth the day they departed. Sourced
-- from the watchlist lookup (see readWatchlistStatus/getPastPlayers in
-- main.js and the PAST PLAYERS WATCHLIST LOOKUP block in export_all.lua)
-- — the same safe "players" table walk export_squad.lua already uses,
-- never the crash-prone "transfers" table. season_id uses this save's
-- own season timeline (not the player's new club's), so a former
-- player's seasons-with-us (player_season_stats) and seasons-since
-- (this table) sit on one continuous axis — see getPlayerHistory, which
-- unions both.
CREATE TABLE IF NOT EXISTS former_player_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    season_id INTEGER NOT NULL,
    overall INTEGER,
    potential INTEGER,
    club_id INTEGER,
    club_name TEXT,
    attributes_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(season_id) REFERENCES seasons(id),
    UNIQUE(player_id, season_id)
);

-- Manual fail-safe for "Academy Graduate" detection, which normally goes
-- purely off youth_academy_snapshot (see getInferredTransfers/
-- getSignedPlayers in main.js). A promotion that happens between two live
-- exports can slip through with nothing ever recorded in that table, so
-- this lets the user mark the gap by hand from the player profile page
-- (Youth Mode only — see the "Mark as Academy Graduate" button in
-- index.html). Consulted as a second source everywhere is_academy is
-- computed; never written to automatically.
CREATE TABLE IF NOT EXISTS academy_graduate_overrides (
    player_id INTEGER NOT NULL,
    save_id INTEGER NOT NULL,
    marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (player_id, save_id),
    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(save_id) REFERENCES saves(id)
);

-- Real transfer/loan fees, read directly from the Career Mode Transfer
-- Manager's negotiation-storage memory (see export_all.lua's TRANSFERS
-- EXPORT block) rather than the "transfers"/"transferhistory" DB tables,
-- which crash the game on read (see feedback_live_editor_data_safety
-- memory). That negotiation storage only ever holds the CURRENT season's
-- succeeded deals — reset by the game itself every season — so this is
-- upserted every sync rather than replaced wholesale, and accumulates
-- across seasons instead of losing prior seasons' deals when the game's
-- own memory resets. The UNIQUE key includes deal_date so the same player
-- transferring twice across different seasons gets two rows, not one
-- overwriting the other; re-syncing mid-season (deal already captured,
-- same key) just updates fee/team-name in place instead of duplicating.
CREATE TABLE IF NOT EXISTS transfer_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    save_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    from_team_id INTEGER,
    to_team_id INTEGER,
    from_team_name TEXT,
    to_team_name TEXT,
    deal_type TEXT,            -- 'transfer' | 'loan'
    fee INTEGER DEFAULT 0,
    exchange_value INTEGER DEFAULT 0,
    deal_date TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(player_id),
    FOREIGN KEY(save_id) REFERENCES saves(id),
    UNIQUE(save_id, player_id, from_team_id, to_team_id, deal_date)
);