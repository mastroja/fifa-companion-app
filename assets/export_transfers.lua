require 'imports/other/helpers'

-- ============================================================
-- Rebuilt from scratch — this file previously contained a
-- copy/pasted squad-export script (wrong logic entirely, and it
-- wrote to the squad export path instead of this one). That's
-- why the Transfers Hub / player profile transfer history never
-- updated with fresh data.
--
-- BEST-EFFORT NOTE: "transferhistory" below is our best guess at
-- the Live Editor table name for transfer records — it hasn't
-- been confirmed against Live Editor's own table browser. If this
-- script runs and ea_fc_transfers_export.json ends up empty (or
-- the log below reports 0 transfers), open Live Editor's database
-- table list, find the real transfer-history table, and swap the
-- table/field names marked below.
-- ============================================================

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

function get_transfer_data()
    local result = {}
    local user_team_id = GetUserTeamID()

    -- TODO verify table name: "transferhistory" is unconfirmed.
    local transfers_table = LE.db:GetTable("transferhistory")
    if not transfers_table then
        print("[CompanionApp] WARNING: 'transferhistory' table not found — check the real table name in Live Editor's database browser and update export_transfers.lua.")
        return result
    end

    local record = transfers_table:GetFirstRecord()
    while record > 0 do
        -- TODO verify field names: playerid/fromteamid/toteamid/value are unconfirmed.
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
    return '{"transfers":[' .. table.concat(parts, ",") .. ']}'
end

assert(IsInCM(), "Script must be executed in career mode")

local transfers = get_transfer_data()
local file = io.open(json_path, "w+")
if file then
    file:write(serialize_to_json(transfers))
    file:close()
    print(string.format("[CompanionApp] Exported %d transfers to %s", #transfers, json_path))
else
    print("[CompanionApp] ERROR: Could not open transfers output path.")
end
