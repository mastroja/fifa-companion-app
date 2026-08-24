MEMORY = require 'imports/core/memory'
require 'imports/other/helpers'
require 'imports/services/enums'

assert(IsInCM(), "Script must be executed in career mode")

function GetFCEDataManager() 
    local IFCEInterface = GetPlugin(ENUM_djb2IFCEInterface_CLSS)
    return MEMORY:ReadMultilevelPointer(IFCEInterface, {0x18, 0x10, 0x08, 0x00})
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

local json_output = string.format(
    '{\n  "current_date": "%s",\n  "calendar": [\n    %s\n  ]\n}',
    formatted_date,
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