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

function get_squad_data()
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

    -- Players WE'VE loaned OUT (playerloans.teamidloanedfrom == our team)
    -- need their real current club resolved via teamplayerlinks —
    -- GetTeamIdFromPlayerId keeps returning their contract/parent club
    -- (us) even while they're out on loan elsewhere, which was showing
    -- as "Loaned to Arsenal" in the UI (nonsensical — you can't be loaned
    -- to your own parent club). teamplayerlinks.teamid reflects who
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
                -- Alternate positions the player can also play — up to 5 more
                -- slots (preferredposition2..6), -1 meaning "not set". Built
                -- into a comma-separated string of just the real position ids
                -- (dropping -1s) since that's all the UI needs to display them.
                local alt_position_ids = {}
                for i = 2, 6 do
                    local alt_pos = players_table:GetRecordFieldValue(current_record, "preferredposition" .. i)
                    if alt_pos and alt_pos ~= -1 then
                        table.insert(alt_position_ids, tostring(alt_pos))
                    end
                end
                local alt_positions = table.concat(alt_position_ids, ",")
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
                player.alt_positions = alt_positions
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
    for i=1, #all_stats do
        local stat = all_stats[i]
        local playerid = stat.playerid
        local app = stat.app or 0

        -- "World's Game" is a generic/unlicensed exhibition bucket, not
        -- a real competition — excluded from every player's stats
        -- entirely (both the totals and the per-competition breakdown)
        -- per user request.
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

    -- avg_rating was previously just whatever competition happened to be
    -- processed last (a plain overwrite, not an average at all) — now a
    -- proper appearances-weighted average across every competition, so
    -- e.g. 7.1 over 30 games outweighs 9.0 over 3.
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

local function serialize_to_json(tbl, save_uid, current_date)
    local json = string.format('{"save_uid":"%s","current_date":"%s","players":[', save_uid:gsub('"', '\\"'), current_date)
    for i, p in ipairs(tbl) do
        local attr = p.attributes or {}
        json = json .. string.format(
            '{"player_id":%d,"name":"%s","overall":%d,"potential":%d,"position_id":%d,"alt_positions":"%s","nationality":%d,"club_id":%d,"club_name":"%s","photo_id":%d,"dob":"%s","height":"%s","weight":"%s","preferred_foot":"%s","skill_moves":%d,"weak_foot":%d,"contract_expiry":"%s","playerjointeamdate":"%s","wage":%d,"duration_months":%d,"contract_date":"%s","player_role_":%d,"last_status_change_date":"%s","is_among_top_scorers":%s,"jersey_number":%d,"injury":%s,"league_goals_prev_three_matches":%d,"is_among_top_scorers_in_team":%s,"form":%d,"on_loan":%s,"loan_team_from":%d,"loan_club_name":"%s","loan_date_end":"%s","is_loan_to_buy":%s,"goals":%d,"assists":%d,"appearances":%d,"clean_sheets":%d,"saves":%d,"yellow_cards":%d,"red_cards":%d,"avg_rating":%.2f,"competitions":[',
            p.player_id, p.name:gsub('"', '\\"'), p.overall, p.potential, p.position_id, p.alt_positions, p.nationality, p.club_id, p.club_name:gsub('"', '\\"'), p.photo_id,
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

assert(IsInCM(), "Script must be executed in career mode")
local save_uid = GetSaveUID() or ""
local current_date_tbl = GetCurrentDate()
local current_date_str = string.format("%04d-%02d-%02d", current_date_tbl.year, current_date_tbl.month, current_date_tbl.day)
local squad_array = get_squad_data()
local file = io.open(json_path, "w+")
if file then
    file:write(serialize_to_json(squad_array, save_uid, current_date_str))
    file:close()
    LOGGER:LogInfo("EA FC Companion: Squad export with headassetid and badges successful!")
else
    LOGGER:LogError("EA FC Companion: Failed to open export path.")
end