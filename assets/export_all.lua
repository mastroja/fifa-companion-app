-- ============================================================
-- EA FC Career Companion — Combined Export
--
-- Runs the squad, transfers, and calendar exports together in one
-- shot, so you only need to bind ONE hotkey in Live Editor instead
-- of running all three scripts separately every time.
--
-- Each export below is wrapped in its own `do ... end` block so
-- their internal local variables/functions (e.g. both the squad
-- and transfers exports define their own local `serialize_to_json`)
-- can't collide with each other, even though they now live in one
-- file/one Lua chunk.
--
-- export_squad.lua, export_transfers.lua, and export_career_calendar.lua
-- are left in place unchanged as the source of truth / reference —
-- if you edit the logic in one of them, mirror the change into the
-- matching block below (or ask to have this file regenerated).
-- ============================================================

assert(IsInCM(), "Script must be executed in career mode")

-- Persistent per-career identifier (documented Live Editor function,
-- generates one on first call if the save doesn't have one yet) — lets
-- the companion app tell different saves apart instead of assuming
-- there's only ever one. Included in all three JSON exports below.
-- Declared here (outside every do...end block) so each block's nested
-- scope can read it via closure.
local save_uid = GetSaveUID() or ""

-- ================= SQUAD EXPORT =================
do
    require 'imports/other/helpers'

    local json_path = "C:\\Users\\Public\\ea_fc_squad_export.json"

    local function convertFifaDate(dayOffset)
        if not dayOffset or dayOffset <= 0 then return "" end
        local baseEpochSeconds = -12219292800
        local targetSeconds = baseEpochSeconds + (dayOffset * 86400)
        return os.date("%m-%d-%Y", targetSeconds) or tostring(dayOffset)
    end

    -- ============================================================
    -- TRAITS / PLAYSTYLES — best-effort, unconfirmed table/field names
    -- ("playertraits"/"playerplaystyles" with playerid+traitid/playstyleid
    -- columns). If these tables don't exist in your Live Editor build,
    -- the lookups below just come back empty and traits/play_styles ship
    -- as empty arrays — no crash, but no data either.
    --
    -- We also don't have a real ID -> name mapping, so until you fill in
    -- TRAIT_NAMES / PLAYSTYLE_NAMES below (check Live Editor's own trait
    -- picker UI for the real names against each ID), this exports
    -- "Trait #<id>" / "PlayStyle #<id>" placeholders. Real IDs beat no
    -- data — swap in real names here once confirmed.
    -- ============================================================
    local TRAIT_NAMES = {
        -- [1] = "Flair",
        -- [2] = "Long Throw-in",
    }
    local PLAYSTYLE_NAMES = {
        -- [1] = "Trivela",
        -- [2] = "Power Shot",
    }

    local function trait_label(id)
        return TRAIT_NAMES[id] or ("Trait #" .. tostring(id))
    end

    local function playstyle_label(id)
        return PLAYSTYLE_NAMES[id] or ("PlayStyle #" .. tostring(id))
    end

    local function get_squad_data()
        local result = {}
        local user_team_id = GetUserTeamID()

        local players_table = LE.db:GetTable("players")
        local loans_table = LE.db:GetTable("playerloans")
        local contracts_table = LE.db:GetTable("career_playercontract")
        local teamplayerlinks_table = LE.db:GetTable("teamplayerlinks")
        local traits_table = LE.db:GetTable("playertraits")
        local playstyles_table = LE.db:GetTable("playerplaystyles")

        local traits_lookup = {}
        if traits_table then
            local rec = traits_table:GetFirstRecord()
            while rec > 0 do
                local pid = traits_table:GetRecordFieldValue(rec, "playerid")
                local trait_id = traits_table:GetRecordFieldValue(rec, "traitid")
                if pid and pid > 0 and trait_id and trait_id > 0 then
                    traits_lookup[pid] = traits_lookup[pid] or {}
                    table.insert(traits_lookup[pid], trait_id)
                end
                rec = traits_table:GetNextValidRecord()
            end
        end

        local playstyles_lookup = {}
        if playstyles_table then
            local rec = playstyles_table:GetFirstRecord()
            while rec > 0 do
                local pid = playstyles_table:GetRecordFieldValue(rec, "playerid")
                local playstyle_id = playstyles_table:GetRecordFieldValue(rec, "playstyleid")
                if pid and pid > 0 and playstyle_id and playstyle_id > 0 then
                    playstyles_lookup[pid] = playstyles_lookup[pid] or {}
                    table.insert(playstyles_lookup[pid], playstyle_id)
                end
                rec = playstyles_table:GetNextValidRecord()
            end
        end

        local loan_lookup = {}
        if loans_table then
            local loan_record = loans_table:GetFirstRecord()
            while loan_record > 0 do
                local loan_player_id = loans_table:GetRecordFieldValue(loan_record, "playerid")
                if loan_player_id and loan_player_id > 0 then
                    loan_lookup[loan_player_id] = {
                        team_loaned_from = loans_table:GetRecordFieldValue(loan_record, "teamidloanedfrom") or 0,
                        loan_date_end = loans_table:GetRecordFieldValue(loan_record, "loandateend") or "",
                        is_loan_to_buy = loans_table:GetRecordFieldValue(loan_record, "isloantobuy") or 0
                    }
                end
                loan_record = loans_table:GetNextValidRecord()
            end
        end

        local contract_lookup = {}
        if contracts_table then
            local contract_record = contracts_table:GetFirstRecord()
            while contract_record > 0 do
                local contract_player_id = contracts_table:GetRecordFieldValue(contract_record, "playerid")
                if contract_player_id and contract_player_id > 0 then
                    contract_lookup[contract_player_id] = {
                        wage = contracts_table:GetRecordFieldValue(contract_record, "wage") or 0,
                        duration_months = contracts_table:GetRecordFieldValue(contract_record, "duration_months") or 0,
                        contract_date = contracts_table:GetRecordFieldValue(contract_record, "contract_date") or "",
                        player_role_ = contracts_table:GetRecordFieldValue(contract_record, "playerrole") or 0,
                        last_status_change_date = contracts_table:GetRecordFieldValue(contract_record, "last_status_change_date") or ""
                    }
                end
                contract_record = contracts_table:GetNextValidRecord()
            end
        end

        local tpl_lookup = {}
        if teamplayerlinks_table then
            local tpl_record = teamplayerlinks_table:GetFirstRecord()
            while tpl_record > 0 do
                local tpl_player_id = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "playerid")
                if tpl_player_id and tpl_player_id > 0 then
                    tpl_lookup[tpl_player_id] = {
                        is_among_top_scorers = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "isamongtopscorers") or 0,
                        jersey_number = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "jerseynumber") or 0,
                        injury = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "injury") or 0,
                        league_goals_prev_three_matches = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "leaguegoalsprevthreematches") or 0,
                        is_among_top_scorers_in_team = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "isamongtopscorersinteam") or 0,
                        form = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "form") or 0,
                        team_id = teamplayerlinks_table:GetRecordFieldValue(tpl_record, "teamid") or 0
                    }
                end
                tpl_record = teamplayerlinks_table:GetNextValidRecord()
            end
        end

        -- Players WE'VE loaned OUT (playerloans.teamidloanedfrom == our
        -- team) need their real current club resolved via teamplayerlinks
        -- — GetTeamIdFromPlayerId keeps returning their contract/parent
        -- club (us) even while out on loan, which was showing as "Loaned
        -- to Arsenal" in the UI. teamplayerlinks.teamid reflects who
        -- they're actually registered to play for right now.
        local loaned_out_destination = {}
        for pid, info in pairs(loan_lookup) do
            if info.team_loaned_from == user_team_id then
                local tpl_info_for_loan = tpl_lookup[pid]
                if tpl_info_for_loan and tpl_info_for_loan.team_id and tpl_info_for_loan.team_id > 0 then
                    loaned_out_destination[pid] = tpl_info_for_loan.team_id
                end
            end
        end

        local current_record = players_table:GetFirstRecord()

        while current_record > 0 do
            local playerid = players_table:GetRecordFieldValue(current_record, "playerid")

            if playerid and playerid > 0 then
                local team_id = GetTeamIdFromPlayerId(playerid)
                local loan_info = loan_lookup[playerid]
                local contract_info = contract_lookup[playerid]
                local tpl_info = tpl_lookup[playerid]
                local is_user_team = (team_id == user_team_id)
                local is_loaned_out = (loan_info and team_id ~= user_team_id and loan_info.team_loaned_from == user_team_id)

                if is_user_team or is_loaned_out then
                    local preferredposition1 = players_table:GetRecordFieldValue(current_record, "preferredposition1")
                    local overall = players_table:GetRecordFieldValue(current_record, "overallrating") or 0
                    local potential = players_table:GetRecordFieldValue(current_record, "potential") or 0
                    local nationality_id = players_table:GetRecordFieldValue(current_record, "nationality") or 0

                    -- Use headassetid for custom/scanned face lookups, fallback to playerid
                    local asset_id = players_table:GetRecordFieldValue(current_record, "headassetid")
                    local photo_id = (asset_id and asset_id > 0) and asset_id or playerid

                    local raw_birthdate = players_table:GetRecordFieldValue(current_record, "birthdate") or 0
                    local height = players_table:GetRecordFieldValue(current_record, "height") or 183
                    local weight = players_table:GetRecordFieldValue(current_record, "weight") or 78
                    local raw_join_date = players_table:GetRecordFieldValue(current_record, "playerjointeamdate") or 0

                    local foot_val = players_table:GetRecordFieldValue(current_record, "preferredfoot") or 1
                    local preferred_foot = (foot_val == 2) and "Left" or "Right"

                    local skill_moves_val = players_table:GetRecordFieldValue(current_record, "skillmoves") or 3
                    local weak_foot_val = players_table:GetRecordFieldValue(current_record, "weakfootabilitytypecode") or 3
                    local contract_valid_until = players_table:GetRecordFieldValue(current_record, "contractvaliduntil") or 2028

                    local acceleration = players_table:GetRecordFieldValue(current_record, "acceleration") or 70
                    local sprint_speed = players_table:GetRecordFieldValue(current_record, "sprintspeed") or 70
                    local finishing = players_table:GetRecordFieldValue(current_record, "finishing") or 70
                    local long_shots = players_table:GetRecordFieldValue(current_record, "longshots") or 70
                    local shot_power = players_table:GetRecordFieldValue(current_record, "shotpower") or 70
                    local positioning = players_table:GetRecordFieldValue(current_record, "positioning") or 70
                    local penalties = players_table:GetRecordFieldValue(current_record, "penalties") or 70
                    local volleys = players_table:GetRecordFieldValue(current_record, "volleys") or 70

                    local short_passing = players_table:GetRecordFieldValue(current_record, "shortpassing") or 70
                    local vision = players_table:GetRecordFieldValue(current_record, "vision") or 70
                    local crossing = players_table:GetRecordFieldValue(current_record, "crossing") or 70
                    local long_passing = players_table:GetRecordFieldValue(current_record, "longpassing") or 70
                    local curve = players_table:GetRecordFieldValue(current_record, "curve") or 70
                    local free_kick_accuracy = players_table:GetRecordFieldValue(current_record, "freekickaccuracy") or 70

                    local dribbling_attr = players_table:GetRecordFieldValue(current_record, "dribbling") or 70
                    local ball_control = players_table:GetRecordFieldValue(current_record, "ballcontrol") or 70
                    local agility = players_table:GetRecordFieldValue(current_record, "agility") or 70
                    local balance = players_table:GetRecordFieldValue(current_record, "balance") or 70

                    local marking = players_table:GetRecordFieldValue(current_record, "defensiveawareness") or players_table:GetRecordFieldValue(current_record, "marking") or 70
                    local standing_tackle = players_table:GetRecordFieldValue(current_record, "standingtackle") or 70
                    local interceptions = players_table:GetRecordFieldValue(current_record, "interceptions") or 70
                    local heading_accuracy = players_table:GetRecordFieldValue(current_record, "headingaccuracy") or 70
                    local sliding_tackle = players_table:GetRecordFieldValue(current_record, "slidingtackle") or 70

                    local strength = players_table:GetRecordFieldValue(current_record, "strength") or 70
                    local stamina = players_table:GetRecordFieldValue(current_record, "stamina") or 70
                    local aggression = players_table:GetRecordFieldValue(current_record, "aggression") or 70
                    local jumping = players_table:GetRecordFieldValue(current_record, "jumping") or 70

                    local gk_diving = players_table:GetRecordFieldValue(current_record, "gkdiving") or 70
                    local gk_handling = players_table:GetRecordFieldValue(current_record, "gkhandling") or 70
                    local gk_kicking = players_table:GetRecordFieldValue(current_record, "gkkicking") or 70
                    local gk_positioning = players_table:GetRecordFieldValue(current_record, "gkpositioning") or 70
                    local gk_reflexes = players_table:GetRecordFieldValue(current_record, "gkreflexes") or 70

                    local player = {}
                    player.player_id = playerid
                    player.name = GetPlayerName(playerid)
                    player.position_id = preferredposition1
                    player.overall = overall
                    player.potential = potential
                    player.nationality = nationality_id
                    local resolved_team_id = loaned_out_destination[playerid] or team_id
                    player.club_id = resolved_team_id
                    player.club_name = (resolved_team_id and resolved_team_id > 0) and (GetTeamName(resolved_team_id) or "") or ""
                    player.photo_id = photo_id
                    player.dob = convertFifaDate(raw_birthdate)
                    player.height = tostring(height) .. " cm"
                    player.weight = tostring(weight) .. " kg"
                    player.preferred_foot = preferred_foot
                    player.skill_moves = skill_moves_val
                    player.weak_foot = weak_foot_val
                    player.contract_expiry = tostring(contract_valid_until)
                    player.playerjointeamdate = convertFifaDate(raw_join_date)

                    local loan_club_name = ""
                    if loan_info and loan_info.team_loaned_from and loan_info.team_loaned_from > 0 then
                        loan_club_name = GetTeamName(loan_info.team_loaned_from) or ""
                    end

                    player.on_loan = (loan_info ~= nil)
                    player.loan_team_from = loan_info and loan_info.team_loaned_from or 0
                    player.loan_club_name = loan_club_name
                    player.loan_date_end = loan_info and convertFifaDate(loan_info.loan_date_end) or ""
                    player.is_loan_to_buy = loan_info and (loan_info.is_loan_to_buy == 1) or false

                    player.wage = contract_info and contract_info.wage or 0
                    player.duration_months = contract_info and contract_info.duration_months or 0
                    player.contract_date = contract_info and tostring(contract_info.contract_date) or ""
                    player.player_role_ = contract_info and contract_info.player_role_ or 0
                    player.last_status_change_date = contract_info and tostring(contract_info.last_status_change_date) or ""

                    player.is_among_top_scorers = tpl_info and (tpl_info.is_among_top_scorers == 1) or false
                    player.jersey_number = tpl_info and tpl_info.jersey_number or 0
                    player.injury = tpl_info and (tpl_info.injury == 1) or false
                    player.league_goals_prev_three_matches = tpl_info and tpl_info.league_goals_prev_three_matches or 0
                    player.is_among_top_scorers_in_team = tpl_info and (tpl_info.is_among_top_scorers_in_team == 1) or false
                    player.form = tpl_info and tpl_info.form or 0

                    player.attributes = {
                        acceleration = acceleration, sprint_speed = sprint_speed, finishing = finishing,
                        long_shots = long_shots, shot_power = shot_power, positioning = positioning,
                        penalties = penalties, volleys = volleys, short_passing = short_passing,
                        vision = vision, crossing = crossing, long_passing = long_passing,
                        curve = curve, fk_accuracy = free_kick_accuracy, dribbling = dribbling_attr,
                        ball_control = ball_control, agility = agility, balance = balance,
                        marking = marking, standing_tackle = standing_tackle, interceptions = interceptions,
                        heading_accuracy = heading_accuracy, sliding_tackle = sliding_tackle,
                        strength = strength, stamina = stamina, aggression = aggression, jumping = jumping,
                        diving = gk_diving, handling = gk_handling, kicking = gk_kicking,
                        gk_positioning = gk_positioning, reflexes = gk_reflexes
                    }

                    player.goals = 0
                    player.assists = 0
                    player.appearances = 0
                    player.clean_sheets = 0
                    player.saves = 0
                    player.yellow_cards = 0
                    player.red_cards = 0
                    player.avg_rating = 0.0
                    player.competitions = {}

                    player.traits = {}
                    for _, trait_id in ipairs(traits_lookup[playerid] or {}) do
                        table.insert(player.traits, trait_label(trait_id))
                    end

                    player.play_styles = {}
                    for _, playstyle_id in ipairs(playstyles_lookup[playerid] or {}) do
                        table.insert(player.play_styles, playstyle_label(playstyle_id))
                    end

                    result[playerid] = player
                end
            end
            current_record = players_table:GetNextValidRecord()
        end

        local all_stats = GetPlayersStats()
        for i = 1, #all_stats do
            local stat = all_stats[i]
            local playerid = stat.playerid
            local app = stat.app or 0

            -- "World's Game" is a generic/unlicensed exhibition bucket,
            -- not a real competition — excluded from every player's
            -- stats entirely (both totals and the per-competition
            -- breakdown) per user request.
            if result[playerid] ~= nil and stat.compname ~= "World's Game" then
                local player = result[playerid]
                if player.name == "" then player.name = GetPlayerName(playerid) end

                local avg = stat.avg or 0
                if app > 1 then avg = (avg / app) / 10 elseif app == 1 then avg = avg / 10 end

                player.goals = player.goals + (stat.goals or 0)
                player.assists = player.assists + (stat.assists or 0)
                player.appearances = player.appearances + app
                player.clean_sheets = player.clean_sheets + (stat.clean_sheets or 0)
                player.saves = player.saves + (stat.saves or 5)
                player.yellow_cards = player.yellow_cards + (stat.yellow or 0)
                player.red_cards = player.red_cards + (stat.red or 0)

                table.insert(player.competitions, {
                    comp_name = stat.compname or "Unknown Competition",
                    appearances = app, goals = stat.goals or 0, assists = stat.assists or 0,
                    clean_sheets = stat.clean_sheets or 0, saves = stat.saves or 0,
                    yellow_cards = stat.yellow or 0, red_cards = stat.red or 0, avg_rating = avg
                })
            end
        end

        -- avg_rating was previously just whatever competition happened to
        -- be processed last (a plain overwrite, not an average at all) —
        -- now a proper appearances-weighted average across every
        -- competition, so e.g. 7.1 over 30 games outweighs 9.0 over 3.
        for _, player in pairs(result) do
            local weighted_sum = 0
            local total_apps = 0
            for _, comp in ipairs(player.competitions) do
                weighted_sum = weighted_sum + (comp.avg_rating * comp.appearances)
                total_apps = total_apps + comp.appearances
            end
            player.avg_rating = (total_apps > 0) and (weighted_sum / total_apps) or 0
        end

        local squad_array = {}
        for _, player in pairs(result) do table.insert(squad_array, player) end
        return squad_array
    end

    local function serialize_string_array(arr)
        local parts = {}
        for i, s in ipairs(arr or {}) do
            parts[i] = '"' .. tostring(s):gsub('"', '\\"') .. '"'
        end
        return '[' .. table.concat(parts, ",") .. ']'
    end

    local function serialize_to_json(tbl, current_date)
        local json = string.format('{"save_uid":"%s","current_date":"%s","players":[', save_uid:gsub('"', '\\"'), current_date)
        for i, p in ipairs(tbl) do
            local attr = p.attributes or {}
            json = json .. string.format(
                '{"player_id":%d,"name":"%s","overall":%d,"potential":%d,"position_id":%d,"nationality":%d,"club_id":%d,"club_name":"%s","photo_id":%d,"dob":"%s","height":"%s","weight":"%s","preferred_foot":"%s","skill_moves":%d,"weak_foot":%d,"contract_expiry":"%s","playerjointeamdate":"%s","wage":%d,"duration_months":%d,"contract_date":"%s","player_role_":%d,"last_status_change_date":"%s","is_among_top_scorers":%s,"jersey_number":%d,"injury":%s,"league_goals_prev_three_matches":%d,"is_among_top_scorers_in_team":%s,"form":%d,"on_loan":%s,"loan_team_from":%d,"loan_club_name":"%s","loan_date_end":"%s","is_loan_to_buy":%s,"goals":%d,"assists":%d,"appearances":%d,"clean_sheets":%d,"saves":%d,"yellow_cards":%d,"red_cards":%d,"avg_rating":%.2f,"competitions":[',
                p.player_id, p.name:gsub('"', '\\"'), p.overall, p.potential, p.position_id, p.nationality, p.club_id, p.club_name:gsub('"', '\\"'), p.photo_id,
                p.dob, p.height, p.weight, p.preferred_foot, p.skill_moves, p.weak_foot, p.contract_expiry, p.playerjointeamdate,
                p.wage, p.duration_months, p.contract_date, p.player_role_, p.last_status_change_date,
                tostring(p.is_among_top_scorers), p.jersey_number, tostring(p.injury), p.league_goals_prev_three_matches, tostring(p.is_among_top_scorers_in_team), p.form,
                tostring(p.on_loan), p.loan_team_from, p.loan_club_name:gsub('"', '\\"'), p.loan_date_end, tostring(p.is_loan_to_buy),
                p.goals, p.assists, p.appearances, p.clean_sheets, p.saves, p.yellow_cards, p.red_cards, p.avg_rating
            )

            for j, c in ipairs(p.competitions) do
                json = json .. string.format(
                    '{"comp_name":"%s","appearances":%d,"goals":%d,"assists":%d,"clean_sheets":%d,"saves":%d,"yellow_cards":%d,"red_cards":%d,"avg_rating":%.2f}',
                    c.comp_name:gsub('"', '\\"'), c.appearances, c.goals, c.assists, c.clean_sheets, c.saves, c.yellow_cards, c.red_cards, c.avg_rating
                )
                if j < #p.competitions then json = json .. "," end
            end

            json = json .. '],"traits":' .. serialize_string_array(p.traits)
            json = json .. ',"play_styles":' .. serialize_string_array(p.play_styles)

            json = json .. ',"attributes":'
            json = json .. string.format(
                '{"acceleration":%d,"sprint_speed":%d,"finishing":%d,"long_shots":%d,"shot_power":%d,"positioning":%d,"penalties":%d,"volleys":%d,"short_passing":%d,"vision":%d,"crossing":%d,"long_passing":%d,"curve":%d,"fk_accuracy":%d,"dribbling":%d,"ball_control":%d,"agility":%d,"balance":%d,"marking":%d,"standing_tackle":%d,"interceptions":%d,"heading_accuracy":%d,"sliding_tackle":%d,"strength":%d,"stamina":%d,"aggression":%d,"jumping":%d,"diving":%d,"handling":%d,"kicking":%d,"gk_positioning":%d,"reflexes":%d}}',
                attr.acceleration or 70, attr.sprint_speed or 70, attr.finishing or 70, attr.long_shots or 70, attr.shot_power or 70, attr.positioning or 70, attr.penalties or 70, attr.volleys or 70,
                attr.short_passing or 70, attr.vision or 70, attr.crossing or 70, attr.long_passing or 70, attr.curve or 70, attr.fk_accuracy or 70,
                attr.dribbling or 70, attr.ball_control or 70, attr.agility or 70, attr.balance or 70,
                attr.marking or 70, attr.standing_tackle or 70, attr.interceptions or 70, attr.heading_accuracy or 70, attr.sliding_tackle or 70,
                attr.strength or 70, attr.stamina or 70, attr.aggression or 70, attr.jumping or 70,
                attr.diving or 70, attr.handling or 70, attr.kicking or 70, attr.gk_positioning or 70, attr.reflexes or 70
            )

            if i < #tbl then json = json .. "," end
        end
        json = json .. ']}'
        return json
    end

    -- Carrying the in-game date here (not just in the calendar export)
    -- lets main.js resolve the correct season independently of whether
    -- the calendar file has synced yet this run — squad writes first
    -- (see this file's block order), so without its own date it was
    -- trusting a possibly-stale "current season" flag and silently
    -- overwriting the previous season's stats on every season rollover.
    local current_date_tbl = GetCurrentDate()
    local current_date_str = string.format("%04d-%02d-%02d", current_date_tbl.year, current_date_tbl.month, current_date_tbl.day)

    local squad_array = get_squad_data()
    local file = io.open(json_path, "w+")
    if file then
        file:write(serialize_to_json(squad_array, current_date_str))
        file:close()
        LOGGER:LogInfo("EA FC Companion: Squad export with headassetid and badges successful!")
    else
        LOGGER:LogError("EA FC Companion: Failed to open squad export path.")
    end
end

-- ================= PAST PLAYERS WATCHLIST LOOKUP =================
-- Looks up current overall/potential/club for specific former-squad
-- player IDs the companion app asks about (written to
-- ea_fc_watchlist_input.json each time the app syncs). Deliberately uses
-- the same "players" table export_squad.lua already iterates safely
-- every refresh — NOT the "transfers" table, which is a confirmed,
-- permanent crash (see feedback_live_editor_data_safety memory). If the
-- watchlist file doesn't exist yet, this is a no-op.
do
    require 'imports/other/helpers'
    local JSON = require 'imports/external/json'

    local watchlist_path = "C:\\Users\\Public\\ea_fc_watchlist_input.json"
    local status_path = "C:\\Users\\Public\\ea_fc_watchlist_status.json"

    local watch_ids = {}
    local watch_count = 0
    local wf = io.open(watchlist_path, "r")
    if wf then
        local content = wf:read("*a")
        wf:close()
        local ok, parsed = pcall(JSON.decode, content)
        if ok and parsed and parsed.player_ids then
            for _, pid in ipairs(parsed.player_ids) do
                watch_ids[pid] = true
                watch_count = watch_count + 1
            end
        end
    end

    if watch_count > 0 then
        local results = {}
        local players_table = LE.db:GetTable("players")
        local record = players_table:GetFirstRecord()
        while record > 0 do
            local playerid = players_table:GetRecordFieldValue(record, "playerid")
            if playerid and watch_ids[playerid] then
                local overall = players_table:GetRecordFieldValue(record, "overallrating") or 0
                local potential = players_table:GetRecordFieldValue(record, "potential") or 0
                local team_id = GetTeamIdFromPlayerId(playerid)
                local club_name = (team_id and team_id > 0) and (GetTeamName(team_id) or "") or ""

                table.insert(results, {
                    player_id = playerid,
                    overall = overall,
                    potential = potential,
                    club_id = team_id or 0,
                    club_name = club_name
                })
            end
            record = players_table:GetNextValidRecord()
        end

        local ok, encoded = pcall(JSON.encode, { players = results })
        if ok then
            local sfile = io.open(status_path, "w+")
            if sfile then
                sfile:write(encoded)
                sfile:close()
                print(string.format("[CompanionApp] Past-players watchlist: found %d/%d.", #results, watch_count))
            end
        end
    end
end

-- ================= YOUTH ACADEMY EXPORT =================
-- "career_youthplayers" confirmed safe via a standalone probe
-- (2026-08-26 — only ~2 rows found, not the whole game's academies,
-- so it already appears scoped to the user's own save). Cross-
-- referenced against the global "players" table for bio/rating data,
-- same pattern as the past-players watchlist above. potentialvariance
-- gives a real uncertainty range around their true potential —
-- deliberately exported as potential_low/potential_high rather than
-- the exact number, so scouting a prospect isn't a guaranteed thing.
do
    require 'imports/other/helpers'

    local function convertFifaDate(dayOffset)
        if not dayOffset or dayOffset <= 0 then return "" end
        local baseEpochSeconds = -12219292800
        local targetSeconds = baseEpochSeconds + (dayOffset * 86400)
        return os.date("%m-%d-%Y", targetSeconds) or tostring(dayOffset)
    end

    local youth_json_list = {}
    local youth_table = LE.db:GetTable("career_youthplayers")
    if youth_table then
        local youth_lookup = {}
        local y_record = youth_table:GetFirstRecord()
        while y_record > 0 do
            local pid = youth_table:GetRecordFieldValue(y_record, "playerid")
            if pid and pid > 0 then
                youth_lookup[pid] = {
                    tier = youth_table:GetRecordFieldValue(y_record, "playertier") or 0,
                    months_in_squad = youth_table:GetRecordFieldValue(y_record, "monthsinsquad") or 0,
                    variance = youth_table:GetRecordFieldValue(y_record, "potentialvariance") or 0
                }
            end
            y_record = youth_table:GetNextValidRecord()
        end

        if next(youth_lookup) ~= nil then
            local players_table = LE.db:GetTable("players")
            local yp_record = players_table:GetFirstRecord()
            while yp_record > 0 do
                local yp_id = players_table:GetRecordFieldValue(yp_record, "playerid")
                if yp_id and youth_lookup[yp_id] then
                    local info = youth_lookup[yp_id]
                    local potential = players_table:GetRecordFieldValue(yp_record, "potential") or 0
                    local overall = players_table:GetRecordFieldValue(yp_record, "overallrating") or 0
                    local pos = players_table:GetRecordFieldValue(yp_record, "preferredposition1") or 0
                    local raw_dob = players_table:GetRecordFieldValue(yp_record, "birthdate") or 0

                    local potential_low = math.max(potential - info.variance, 1)
                    local potential_high = math.min(potential + info.variance, 99)

                    table.insert(youth_json_list, string.format(
                        '{"player_id":%d,"name":"%s","position_id":%d,"overall":%d,"potential_low":%d,"potential_high":%d,"dob":"%s","tier":%d,"months_in_squad":%d}',
                        yp_id, (GetPlayerName(yp_id) or ""):gsub('"', '\\"'), pos, overall, potential_low, potential_high,
                        convertFifaDate(raw_dob), info.tier, info.months_in_squad
                    ))
                end
                yp_record = players_table:GetNextValidRecord()
            end
        end
    end

    local json_output = string.format(
        '{"save_uid":"%s","youth_academy":[%s]}',
        save_uid:gsub('"', '\\"'), table.concat(youth_json_list, ",")
    )
    local file = io.open("C:\\Users\\Public\\ea_fc_youth_export.json", "w+")
    if file then
        file:write(json_output)
        file:close()
        print(string.format("[CompanionApp] Exported %d youth academy players.", #youth_json_list))
    end
end

-- ================= TRANSFERS EXPORT =================
do
    require 'imports/other/helpers'

    -- Uses the "transfers" DB table (playerid/sellingteamid/buyingteamid/
    -- transferamount), confirmed via schema dump 2026-08-25 — the earlier
    -- "transferhistory" guess doesn't exist in this game version.

    local json_path = "C:\\Users\\Public\\ea_fc_transfers_export.json"
    local BIG_MONEY_THRESHOLD = 60000000

    local function safe_player_name(playerid)
        local ok, name = pcall(GetPlayerName, playerid)
        if ok and type(name) == "string" and #name > 0 then return name end
        return "Player " .. tostring(playerid)
    end

    local function safe_team_name(teamid)
        if not teamid or teamid <= 0 then return "Free Agents" end
        local ok, name = pcall(GetTeamName, teamid)
        if ok and type(name) == "string" and #name > 0 then return name end
        return "Unknown Club"
    end

    local function get_transfer_data()
        local result = {}
        local user_team_id = GetUserTeamID()

        -- REVERTED 2026-08-25: switching this to the real "transfers" table
        -- crashed the game the first time F10 ran against it — the log shows
        -- the squad export completing fine, then nothing, then a full game
        -- restart. Likely that table is a whole-game-world transfer ledger
        -- (not scoped to this save), and resolving a name for every row
        -- timed out or hit a bad record. Back to the safe no-op ("transferhistory"
        -- doesn't exist, so this just returns empty) until a bounded/pcall'd
        -- probe of "transfers" confirms it's safe to iterate — see
        -- inspect_transfers_table.lua, run manually, NOT via F10.
        local transfers_table = LE.db:GetTable("transferhistory")
        if not transfers_table then
            print("[CompanionApp] WARNING: 'transferhistory' table not found — transfers export disabled pending a safe fix, see comment above.")
            return result
        end

        local record = transfers_table:GetFirstRecord()
        while record > 0 do
            local playerid = transfers_table:GetRecordFieldValue(record, "playerid")
            local from_team_id = transfers_table:GetRecordFieldValue(record, "fromteamid") or 0
            local to_team_id = transfers_table:GetRecordFieldValue(record, "toteamid") or 0
            local fee = transfers_table:GetRecordFieldValue(record, "value")
                or transfers_table:GetRecordFieldValue(record, "fee") or 0

            if playerid and playerid > 0 then
                local is_user = (from_team_id == user_team_id) or (to_team_id == user_team_id)

                table.insert(result, {
                    player_name = safe_player_name(playerid),
                    from_team = safe_team_name(from_team_id),
                    to_team = safe_team_name(to_team_id),
                    fee = fee,
                    is_user = is_user,
                    is_big_money = fee > BIG_MONEY_THRESHOLD
                })
            end

            record = transfers_table:GetNextValidRecord()
        end

        return result
    end

    local function serialize_to_json(transfers)
        local parts = {}
        for i, t in ipairs(transfers) do
            parts[i] = string.format(
                '{"player_name":"%s","from_team":"%s","to_team":"%s","fee":%d,"is_user":%s,"is_league":false,"is_big_money":%s}',
                tostring(t.player_name):gsub('"', '\\"'),
                tostring(t.from_team):gsub('"', '\\"'),
                tostring(t.to_team):gsub('"', '\\"'),
                t.fee or 0,
                tostring(t.is_user),
                tostring(t.is_big_money)
            )
        end
        return string.format('{"save_uid":"%s","transfers":[', save_uid:gsub('"', '\\"')) .. table.concat(parts, ",") .. ']}'
    end

    local transfers = get_transfer_data()
    local file = io.open(json_path, "w+")
    if file then
        file:write(serialize_to_json(transfers))
        file:close()
        print(string.format("[CompanionApp] Exported %d transfers to %s", #transfers, json_path))
    else
        print("[CompanionApp] ERROR: Could not open transfers output path.")
    end
end

-- ================= CALENDAR EXPORT =================
do
    MEMORY = require 'imports/core/memory'
    require 'imports/other/helpers'
    require 'imports/services/enums'

    local function GetFCEDataManager()
        local IFCEInterface = GetPlugin(ENUM_djb2IFCEInterface_CLSS)
        return MEMORY:ReadMultilevelPointer(IFCEInterface, {0x18, 0x10, 0x08, 0x00})
    end

    -- Same day-offset encoding as the squad export's convertFifaDate —
    -- duplicated locally since each do...end block keeps its own copies.
    local function convertFifaDate(dayOffset)
        if not dayOffset or dayOffset <= 0 then return "" end
        local baseEpochSeconds = -12219292800
        local targetSeconds = baseEpochSeconds + (dayOffset * 86400)
        return os.date("%Y-%m-%d", targetSeconds) or tostring(dayOffset)
    end

    local function GetStandingsByIndex(idx)
        local StandingsData = {}
        local FCEDataManager = GetFCEDataManager()
        local StandingsDataList = MEMORY:ReadPointer(FCEDataManager + 0x88)
        local itemSize = 0x18
        local mBegin = MEMORY:ReadPointer(StandingsDataList + 0x28)
        local mCurrent = mBegin + (itemSize * idx)

        StandingsData["mTeamId"] = MEMORY:ReadInt(mCurrent + 0x04)
        return StandingsData
    end

    local function GetActiveCareerFixtures()
        local result = {}
        local FCEDataManager = GetFCEDataManager()
        local FixtureDataList = MEMORY:ReadPointer(FCEDataManager + 0x60)
        if not FixtureDataList or FixtureDataList == 0 then return result end

        local itemSize = 0x18
        local mBegin = MEMORY:ReadPointer(FixtureDataList + 0x28)
        local max_items_count = MEMORY:ReadInt(FixtureDataList + 0x1C) - 1

        for i = 0, max_items_count do
            local mCurrent = mBegin + (itemSize * i)
            local is_used = MEMORY:ReadBool(mCurrent + 0x14)

            if is_used then
                local FixtureData = {}
                FixtureData["mDate"] = MEMORY:ReadInt(mCurrent + 0x00)
                FixtureData["mCompObjId"] = MEMORY:ReadShort(mCurrent + 0x08)
                FixtureData["mHomeStandingId"] = MEMORY:ReadShort(mCurrent + 0x0A)
                FixtureData["mAwayStandingId"] = MEMORY:ReadShort(mCurrent + 0x0C)
                FixtureData["mHomeScore"] = MEMORY:ReadChar(mCurrent + 0x0F)
                FixtureData["mAwayScore"] = MEMORY:ReadChar(mCurrent + 0x11)
                FixtureData["mGameCompletion"] = MEMORY:ReadBool(mCurrent + 0x13)
                table.insert(result, FixtureData)
            end
        end
        return result
    end

    -- Resolve user team ID securely from active manager profile
    local user_team_id = 0
    pcall(function()
        user_team_id = GetUserTeamID()
    end)

    if not user_team_id or user_team_id == 0 then
        local career_users = LE.db:GetTable("career_users")
        if career_users then
            local first_record = career_users:GetFirstRecord()
            if first_record > 0 then
                user_team_id = career_users:GetRecordFieldValue(first_record, "clubteamid")
            end
        end
    end

    -- "teams" is a static team-profile table (colors, captain, ratings,
    -- stadium/history info) — confirmed via Live Editor's DB browser to
    -- have NO live standings fields (no wins/losses/points/rank), so this
    -- only pulls captain + kit colors for the user's own team.
    local captain_id = 0
    local team_colors = { r1 = 0, g1 = 0, b1 = 0, r2 = 0, g2 = 0, b2 = 0, r3 = 0, g3 = 0, b3 = 0 }
    local trophies = { league_titles = 0, domestic_cups = 0, uefa_cl_wins = 0, uefa_el_wins = 0, uefa_uecl_wins = 0 }

    local teams_table = LE.db:GetTable("teams")
    if teams_table then
        local team_record = teams_table:GetFirstRecord()
        while team_record > 0 do
            local tid = teams_table:GetRecordFieldValue(team_record, "teamid")
            if tid and tid == user_team_id then
                captain_id = teams_table:GetRecordFieldValue(team_record, "captainid") or 0
                team_colors.r1 = teams_table:GetRecordFieldValue(team_record, "teamcolor1r") or 0
                team_colors.g1 = teams_table:GetRecordFieldValue(team_record, "teamcolor1g") or 0
                team_colors.b1 = teams_table:GetRecordFieldValue(team_record, "teamcolor1b") or 0
                team_colors.r2 = teams_table:GetRecordFieldValue(team_record, "teamcolor2r") or 0
                team_colors.g2 = teams_table:GetRecordFieldValue(team_record, "teamcolor2g") or 0
                team_colors.b2 = teams_table:GetRecordFieldValue(team_record, "teamcolor2b") or 0
                team_colors.r3 = teams_table:GetRecordFieldValue(team_record, "teamcolor3r") or 0
                team_colors.g3 = teams_table:GetRecordFieldValue(team_record, "teamcolor3g") or 0
                team_colors.b3 = teams_table:GetRecordFieldValue(team_record, "teamcolor3b") or 0
                trophies.league_titles = teams_table:GetRecordFieldValue(team_record, "leaguetitles") or 0
                trophies.domestic_cups = teams_table:GetRecordFieldValue(team_record, "domesticcups") or 0
                trophies.uefa_cl_wins = teams_table:GetRecordFieldValue(team_record, "uefa_cl_wins") or 0
                trophies.uefa_el_wins = teams_table:GetRecordFieldValue(team_record, "uefa_el_wins") or 0
                trophies.uefa_uecl_wins = teams_table:GetRecordFieldValue(team_record, "uefa_uecl_wins") or 0
                break
            end
            team_record = teams_table:GetNextValidRecord()
        end
    end

    -- "manager" is one row per manager across the whole game world (like
    -- "teams"), matched here by teamid. Confirmed fields: firstname,
    -- surname, commonname, managerjointeamdate. No manager-of-the-
    -- year/month award tally exists anywhere in this table — scrolled
    -- its full field list and found nothing award-related, so that part
    -- of the Home page's Manager widget stays unbuilt until a real
    -- source turns up.
    local manager_name = ""
    local manager_join_date = ""

    local manager_table = LE.db:GetTable("manager")
    if manager_table then
        local mgr_record = manager_table:GetFirstRecord()
        while mgr_record > 0 do
            local mtid = manager_table:GetRecordFieldValue(mgr_record, "teamid")
            if mtid and mtid == user_team_id then
                local common_name = manager_table:GetRecordFieldValue(mgr_record, "commonname") or ""
                if common_name ~= "" then
                    manager_name = common_name
                else
                    local first_name = manager_table:GetRecordFieldValue(mgr_record, "firstname") or ""
                    local surname = manager_table:GetRecordFieldValue(mgr_record, "surname") or ""
                    manager_name = (first_name .. " " .. surname):gsub("^%s+", ""):gsub("%s+$", "")
                end
                local raw_join_date = manager_table:GetRecordFieldValue(mgr_record, "managerjointeamdate") or 0
                manager_join_date = convertFifaDate(raw_join_date)
                break
            end
            mgr_record = manager_table:GetNextValidRecord()
        end
    end

    -- ============================================================
    -- MANAGER SEASON HISTORY / PPG — "career_managerhistory" DB table
    -- (confirmed via GetDBTableFields/GetDBTableRows schema dump), one
    -- row per team per season: games_played/points/wins/draws/losses/
    -- tableposition. Real DB table, not a memory read.
    -- ============================================================
    local manager_history_json_list = {}
    local managerhistory_table = LE.db:GetTable("career_managerhistory")
    if managerhistory_table then
        local mh_record = managerhistory_table:GetFirstRecord()
        while mh_record > 0 do
            local mh_teamid = managerhistory_table:GetRecordFieldValue(mh_record, "teamid")
            if mh_teamid and mh_teamid == user_team_id then
                local season = managerhistory_table:GetRecordFieldValue(mh_record, "season") or 0
                local games_played = managerhistory_table:GetRecordFieldValue(mh_record, "games_played") or 0
                local points = managerhistory_table:GetRecordFieldValue(mh_record, "points") or 0
                local wins = managerhistory_table:GetRecordFieldValue(mh_record, "wins") or 0
                local draws = managerhistory_table:GetRecordFieldValue(mh_record, "draws") or 0
                local losses = managerhistory_table:GetRecordFieldValue(mh_record, "losses") or 0
                local table_position = managerhistory_table:GetRecordFieldValue(mh_record, "tableposition") or 0
                local ppg = (games_played > 0) and (points / games_played) or 0

                table.insert(manager_history_json_list, string.format(
                    '{"season":%d,"games_played":%d,"points":%d,"wins":%d,"draws":%d,"losses":%d,"table_position":%d,"ppg":%.2f}',
                    season, games_played, points, wins, draws, losses, table_position, ppg
                ))
            end
            mh_record = managerhistory_table:GetNextValidRecord()
        end
    end

    -- Fetch exact in-game calendar date from career state
    local current_date_tbl = GetCurrentDate()
    local formatted_date = string.format("%04d-%02d-%02d", current_date_tbl.year, current_date_tbl.month, current_date_tbl.day)

    local valid_fixtures = GetActiveCareerFixtures()
    local fixtures_json_list = {}

    -- ============================================================
    -- STANDINGS — built from fixture RESULTS rather than the separate
    -- StandingsData memory struct (Live Editor's own bundled
    -- lua/scripts/export_fixtures.lua has a GetValidStandings() that
    -- reads that struct, but its "is_used" flag proved unreliable in
    -- testing — it only matched 2 rows out of a ~20-team league, and
    -- tellingly the bundled script computes that result and never
    -- actually uses it anywhere, so it was likely never verified by
    -- its own author). Instead, aggregate every completed fixture in
    -- the user's primary competition using GetStandingsByIndex(), which
    -- is already proven correct — it's what resolves every opponent
    -- name in the calendar export below.
    --
    -- The fixture list covers EVERY competition the engine is tracking,
    -- not just the user's own (confirmed: a first attempt at this that
    -- picked "whichever comp_obj_id has the most fixtures overall"
    -- returned a full La Liga table Arsenal isn't even in). So the
    -- competition itself must be picked from fixtures that actually
    -- involve the user's team — resolve each fixture's teams once, use
    -- that to find the comp_obj_id with the most USER fixtures (the
    -- domestic league, ~38 games, vs a handful for cups/groups), then
    -- aggregate every team's record from all fixtures in that same
    -- competition.
    -- ============================================================
    local resolved_fixtures = {}
    for i = 1, #valid_fixtures do
        local f = valid_fixtures[i]
        local hs = GetStandingsByIndex(f["mHomeStandingId"])
        local as = GetStandingsByIndex(f["mAwayStandingId"])
        table.insert(resolved_fixtures, {
            comp_obj_id = f["mCompObjId"],
            date = f["mDate"] or 0,
            home_id = hs["mTeamId"] or 0,
            away_id = as["mTeamId"] or 0,
            home_score = f["mHomeScore"] or 0,
            away_score = f["mAwayScore"] or 0,
            completed = f["mGameCompletion"]
        })
    end

    local comp_fixture_counts = {}
    for i = 1, #resolved_fixtures do
        local rf = resolved_fixtures[i]
        if rf.home_id == user_team_id or rf.away_id == user_team_id then
            comp_fixture_counts[rf.comp_obj_id] = (comp_fixture_counts[rf.comp_obj_id] or 0) + 1
        end
    end

    local primary_comp_obj_id = nil
    local most_fixtures = 0
    for cid, count in pairs(comp_fixture_counts) do
        if count > most_fixtures then
            most_fixtures = count
            primary_comp_obj_id = cid
        end
    end

    local standings_json_list = {}
    if primary_comp_obj_id ~= nil then
        -- Chronological order matters here (unlike the season totals below)
        -- because we track each team's last-5-results form as we go.
        local comp_fixtures = {}
        for i = 1, #resolved_fixtures do
            local rf = resolved_fixtures[i]
            if rf.comp_obj_id == primary_comp_obj_id and rf.completed and rf.home_id > 0 and rf.away_id > 0 then
                table.insert(comp_fixtures, rf)
            end
        end
        table.sort(comp_fixtures, function(a, b) return a.date < b.date end)

        local team_stats = {}
        local function ensure_team(tid)
            if not team_stats[tid] then
                team_stats[tid] = { wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, played = 0, form = {} }
            end
            return team_stats[tid]
        end

        for i = 1, #comp_fixtures do
            local rf = comp_fixtures[i]
            local home = ensure_team(rf.home_id)
            local away = ensure_team(rf.away_id)
            home.played = home.played + 1
            away.played = away.played + 1
            home.gf = home.gf + rf.home_score
            home.ga = home.ga + rf.away_score
            away.gf = away.gf + rf.away_score
            away.ga = away.ga + rf.home_score

            if rf.home_score > rf.away_score then
                home.wins = home.wins + 1
                away.losses = away.losses + 1
                table.insert(home.form, "W")
                table.insert(away.form, "L")
            elseif rf.home_score < rf.away_score then
                away.wins = away.wins + 1
                home.losses = home.losses + 1
                table.insert(home.form, "L")
                table.insert(away.form, "W")
            else
                home.draws = home.draws + 1
                away.draws = away.draws + 1
                table.insert(home.form, "D")
                table.insert(away.form, "D")
            end
        end

        for tid, s in pairs(team_stats) do
            local points = (s.wins * 3) + s.draws
            local last5 = {}
            for i = math.max(1, #s.form - 4), #s.form do
                table.insert(last5, '"' .. s.form[i] .. '"')
            end
            table.insert(standings_json_list, string.format(
                '{"team_id":%d,"team_name":"%s","played":%d,"wins":%d,"draws":%d,"losses":%d,"gf":%d,"ga":%d,"gd":%d,"points":%d,"form":[%s]}',
                tid, (GetTeamName(tid) or ""):gsub('"', '\\"'), s.played, s.wins, s.draws, s.losses, s.gf, s.ga, s.gf - s.ga, points,
                table.concat(last5, ",")
            ))
        end
    end

    -- ============================================================
    -- ALL-COMPETITIONS STANDINGS/PROGRESS — same fixture-aggregation
    -- technique as the primary-league standings above, generalized to
    -- EVERY competition the user's team has fixtures in (comp_fixture_
    -- counts already has exactly that set of comp_obj_ids). Feeds the
    -- Calendar tab's "Competitions & Standings" widget, which
    -- previously only ever showed hardcoded placeholder text baked
    -- into the HTML. Round-robin-shaped competitions (an opponent
    -- repeats — league or group stage) get a table position; anything
    -- else (knockout cups, opponents don't repeat) gets a W-L record
    -- plus next opponent instead, since no table makes sense there.
    -- No stageid/round-name decoding attempted — we don't have a
    -- verified ID-to-round-name mapping for that.
    -- ============================================================
    local function ordinal_suffix(n)
        local mod100 = n % 100
        if mod100 >= 11 and mod100 <= 13 then return "th" end
        local mod10 = n % 10
        if mod10 == 1 then return "st"
        elseif mod10 == 2 then return "nd"
        elseif mod10 == 3 then return "rd"
        else return "th" end
    end

    local function comp_icon(name)
        local lname = name:lower()
        if lname:find("champions") or lname:find("europa") or lname:find("conference") then return "🏆" end
        if lname:find("cup") or lname:find("shield") then return "🛡️" end
        return "⚽"
    end

    local competitions_json_list = {}
    for comp_obj_id, _ in pairs(comp_fixture_counts) do
        local comp_fixtures_all = {}
        for i = 1, #resolved_fixtures do
            if resolved_fixtures[i].comp_obj_id == comp_obj_id then
                table.insert(comp_fixtures_all, resolved_fixtures[i])
            end
        end

        -- Round-robin shape: does any opponent of the user's team repeat?
        local opponent_counts = {}
        for i = 1, #comp_fixtures_all do
            local rf = comp_fixtures_all[i]
            if rf.home_id == user_team_id or rf.away_id == user_team_id then
                local opp = (rf.home_id == user_team_id) and rf.away_id or rf.home_id
                if opp > 0 then opponent_counts[opp] = (opponent_counts[opp] or 0) + 1 end
            end
        end
        local is_round_robin = false
        for _, count in pairs(opponent_counts) do
            if count > 1 then is_round_robin = true end
        end

        local comp_name = GetCompetitionNameByObjID(comp_obj_id) or "Competition"
        local standing_text = ""

        if is_round_robin then
            local team_stats2 = {}
            local function ensure_team2(tid)
                if not team_stats2[tid] then
                    team_stats2[tid] = { wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, played = 0 }
                end
                return team_stats2[tid]
            end
            for i = 1, #comp_fixtures_all do
                local rf = comp_fixtures_all[i]
                if rf.completed and rf.home_id > 0 and rf.away_id > 0 then
                    local home = ensure_team2(rf.home_id)
                    local away = ensure_team2(rf.away_id)
                    home.played = home.played + 1
                    away.played = away.played + 1
                    home.gf = home.gf + rf.home_score
                    home.ga = home.ga + rf.away_score
                    away.gf = away.gf + rf.away_score
                    away.ga = away.ga + rf.home_score
                    if rf.home_score > rf.away_score then
                        home.wins = home.wins + 1
                        away.losses = away.losses + 1
                    elseif rf.home_score < rf.away_score then
                        away.wins = away.wins + 1
                        home.losses = home.losses + 1
                    else
                        home.draws = home.draws + 1
                        away.draws = away.draws + 1
                    end
                end
            end

            local ranking = {}
            for tid, s in pairs(team_stats2) do
                table.insert(ranking, { team_id = tid, points = (s.wins * 3) + s.draws, gd = s.gf - s.ga })
            end
            table.sort(ranking, function(a, b)
                if a.points ~= b.points then return a.points > b.points end
                return a.gd > b.gd
            end)

            local user_rank = nil
            for idx, r in ipairs(ranking) do
                if r.team_id == user_team_id then user_rank = idx break end
            end

            -- A team sitting 1st mid-season hasn't won the league yet —
            -- only report "Winner" (the same word cups use, and the only
            -- text getTrophiesWon in main.js treats as an actual title)
            -- once every one of the user's team's scheduled fixtures in
            -- this competition has been played (38 for a 20-team double
            -- round-robin, fewer for a smaller league/group).
            local user_total_fixtures = comp_fixture_counts[comp_obj_id] or 0
            local user_completed_fixtures = 0
            for i = 1, #comp_fixtures_all do
                local rf = comp_fixtures_all[i]
                if (rf.home_id == user_team_id or rf.away_id == user_team_id) and rf.completed then
                    user_completed_fixtures = user_completed_fixtures + 1
                end
            end
            local season_complete = user_total_fixtures > 0 and user_completed_fixtures >= user_total_fixtures

            if user_rank then
                if user_rank == 1 and season_complete then
                    standing_text = "Winner"
                else
                    standing_text = string.format("%d%s", user_rank, ordinal_suffix(user_rank))
                end
            else
                -- No completed fixtures yet this season (brand new save/
                -- season) — team_stats2 never gets populated, so there's
                -- no ranking to read a position from. Without this, the
                -- competition was silently dropped from the list entirely
                -- (standing_text stayed "" and the insert below is guarded
                -- on it being non-empty) instead of showing up at all.
                standing_text = "Not Started"
            end
        else
            -- Round-by-round progress instead of a W-L record: the
            -- standing is the last round played in, or "Winner" if they
            -- won the final. No verified round-NAME mapping exists
            -- (would need stageid decoding, which we don't have), so
            -- this counts fixtures sequentially ("4th Round") rather
            -- than using real round names. A draw is treated as still
            -- alive/advancing (assumed won on penalties) since penalty-
            -- shootout results aren't captured anywhere in our fixture
            -- data, only the regular-time score.
            local user_fixtures = {}
            for i = 1, #comp_fixtures_all do
                local rf = comp_fixtures_all[i]
                if rf.home_id == user_team_id or rf.away_id == user_team_id then
                    table.insert(user_fixtures, rf)
                end
            end
            table.sort(user_fixtures, function(a, b) return a.date < b.date end)

            local completed_count = 0
            local last_completed_won = true
            local has_upcoming = false
            for i = 1, #user_fixtures do
                local rf = user_fixtures[i]
                if rf.completed then
                    completed_count = completed_count + 1
                    local user_score = (rf.home_id == user_team_id) and rf.home_score or rf.away_score
                    local opp_score = (rf.home_id == user_team_id) and rf.away_score or rf.home_score
                    last_completed_won = (user_score >= opp_score)
                else
                    has_upcoming = true
                end
            end

            if completed_count == 0 then
                standing_text = "Not Started"
            elseif not last_completed_won then
                standing_text = string.format("%d%s Round", completed_count, ordinal_suffix(completed_count))
            elseif has_upcoming then
                local next_round = completed_count + 1
                standing_text = string.format("%d%s Round", next_round, ordinal_suffix(next_round))
            else
                standing_text = "Winner"
            end
        end

        if standing_text ~= "" then
            table.insert(competitions_json_list, string.format(
                '{"name":"%s","icon":"%s","standing":"%s"}',
                comp_name:gsub('"', '\\"'), comp_icon(comp_name), standing_text:gsub('"', '\\"')
            ))
        end
    end

    for i = 1, #valid_fixtures do
        local f = valid_fixtures[i]
        local home_standings = GetStandingsByIndex(f["mHomeStandingId"])
        local away_standings = GetStandingsByIndex(f["mAwayStandingId"])

        local home_teamid = home_standings["mTeamId"] or 0
        local away_teamid = away_standings["mTeamId"] or 0

        -- Filter strictly for the active user team matches
        if home_teamid == user_team_id or away_teamid == user_team_id then
            local compname = GetCompetitionNameByObjID(f["mCompObjId"]) or "League Match"
            local hometeam = GetTeamName(home_teamid) or "Home Team"
            local awayteam = GetTeamName(away_teamid) or "Away Team"

            local is_home = (home_teamid == user_team_id)
            local opponent_name = is_home and awayteam or hometeam

            local score_str = nil
            if f["mGameCompletion"] then
                score_str = string.format("%d - %d", f["mHomeScore"], f["mAwayScore"])
            end

            local score_json_part = ""
            if score_str then
                score_json_part = ', "score":"' .. score_str .. '"'
            end

            table.insert(fixtures_json_list, string.format(
                '{"date":"%d","competition":"%s","opponent":"%s","is_home":%s,"played":%s%s}',
                f["mDate"],
                compname,
                opponent_name,
                tostring(is_home),
                tostring(f["mGameCompletion"]),
                score_json_part
            ))
        end
    end

    local manager_name_escaped = manager_name:gsub('"', '\\"')
    local club_name_escaped = (GetTeamName(user_team_id) or ""):gsub('"', '\\"')
    local save_uid_escaped = save_uid:gsub('"', '\\"')

    local json_output = string.format(
        '{\n  "save_uid": "%s",\n  "club_name": "%s",\n  "current_date": "%s",\n  "captain_id": %d,\n  "team_colors": {"primary":{"r":%d,"g":%d,"b":%d},"secondary":{"r":%d,"g":%d,"b":%d},"tertiary":{"r":%d,"g":%d,"b":%d}},\n  "trophies": {"league_titles":%d,"domestic_cups":%d,"uefa_cl_wins":%d,"uefa_el_wins":%d,"uefa_uecl_wins":%d},\n  "manager": {"name":"%s","join_date":"%s"},\n  "standings": [\n    %s\n  ],\n  "manager_history": [\n    %s\n  ],\n  "competitions": [\n    %s\n  ],\n  "calendar": [\n    %s\n  ]\n}',
        save_uid_escaped,
        club_name_escaped,
        formatted_date,
        captain_id,
        team_colors.r1, team_colors.g1, team_colors.b1,
        team_colors.r2, team_colors.g2, team_colors.b2,
        team_colors.r3, team_colors.g3, team_colors.b3,
        trophies.league_titles, trophies.domestic_cups, trophies.uefa_cl_wins, trophies.uefa_el_wins, trophies.uefa_uecl_wins,
        manager_name_escaped, manager_join_date,
        table.concat(standings_json_list, ",\n    "),
        table.concat(manager_history_json_list, ",\n    "),
        table.concat(competitions_json_list, ",\n    "),
        table.concat(fixtures_json_list, ",\n    ")
    )

    local target_path = "C:\\Users\\Public\\ea_fc_calendar_export.json"
    local file = io.open(target_path, "w+")
    if file then
        file:write(json_output)
        file:close()
        print("[Lua] Successfully synced career calendar to public path.")
    else
        print("[Lua] Error: Could not write calendar file path.")
    end
end
