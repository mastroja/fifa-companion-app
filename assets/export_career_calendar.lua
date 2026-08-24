MEMORY = require 'imports/core/memory'
require 'imports/other/helpers'
require 'imports/services/enums'

assert(IsInCM(), "Script must be executed in career mode")

function GetFCEDataManager()
    local IFCEInterface = GetPlugin(ENUM_djb2IFCEInterface_CLSS)
    return MEMORY:ReadMultilevelPointer(IFCEInterface, {0x18, 0x10, 0x08, 0x00})
end

-- Same day-offset encoding as the squad export's convertFifaDate.
function convertFifaDate(dayOffset)
    if not dayOffset or dayOffset <= 0 then return "" end
    local baseEpochSeconds = -12219292800
    local targetSeconds = baseEpochSeconds + (dayOffset * 86400)
    return os.date("%Y-%m-%d", targetSeconds) or tostring(dayOffset)
end

function GetStandingsByIndex(idx)
    local StandingsData = {}
    local FCEDataManager = GetFCEDataManager()
    local StandingsDataList = MEMORY:ReadPointer(FCEDataManager + 0x88)
    local itemSize = 0x18
    local mBegin = MEMORY:ReadPointer(StandingsDataList + 0x28)
    local mCurrent = mBegin + (itemSize * idx)
    
    StandingsData["mTeamId"] = MEMORY:ReadInt(mCurrent + 0x04)
    return StandingsData
end

function GetActiveCareerFixtures()
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
-- year/month award tally exists anywhere in this table — scrolled its
-- full field list and found nothing award-related, so that part of the
-- Home page's Manager widget stays unbuilt until a real source turns up.
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

-- Fetch exact in-game calendar date from career state
local current_date_tbl = GetCurrentDate()
local formatted_date = string.format("%04d-%02d-%02d", current_date_tbl.year, current_date_tbl.month, current_date_tbl.day)

local valid_fixtures = GetActiveCareerFixtures()
local fixtures_json_list = {}

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

local json_output = string.format(
    '{\n  "current_date": "%s",\n  "captain_id": %d,\n  "team_colors": {"primary":{"r":%d,"g":%d,"b":%d},"secondary":{"r":%d,"g":%d,"b":%d},"tertiary":{"r":%d,"g":%d,"b":%d}},\n  "trophies": {"league_titles":%d,"domestic_cups":%d,"uefa_cl_wins":%d,"uefa_el_wins":%d,"uefa_uecl_wins":%d},\n  "manager": {"name":"%s","join_date":"%s"},\n  "calendar": [\n    %s\n  ]\n}',
    formatted_date,
    captain_id,
    team_colors.r1, team_colors.g1, team_colors.b1,
    team_colors.r2, team_colors.g2, team_colors.b2,
    team_colors.r3, team_colors.g3, team_colors.b3,
    trophies.league_titles, trophies.domestic_cups, trophies.uefa_cl_wins, trophies.uefa_el_wins, trophies.uefa_uecl_wins,
    manager_name_escaped, manager_join_date,
    table.concat(fixtures_json_list, ",\n    ")
)

local target_path = "C:\\Users\\Public\\ea_fc_calendar_export.json"
local file = io.open(target_path, "w+")
if file then
    file:write(json_output)
    file:close()
    print("[Lua] Successfully synced career calendar to public path.")
else
    print("[Lua] Error: Could not write file path.")
end