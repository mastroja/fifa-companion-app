MEMORY = require 'imports/core/memory'
require 'imports/other/helpers'
require 'imports/career_mode/enums'
require 'imports/career_mode/helpers'

-- ============================================================
-- Real transfer/loan fees, read directly from the Career Mode Transfer
-- Manager's negotiation-storage memory instead of the "transfers"/
-- "transferhistory" DB tables — those are a confirmed, permanent crash on
-- GetFirstRecord() (see feedback_live_editor_data_safety memory: three
-- separate crashes, root-caused to that specific table/API combo, not
-- fixable from a script). Rebuilt 2026-08-29 to mirror a known-working
-- reference script (G:\Mods\fc26\FC 26 LE v26.3.6\lua\scripts\
-- export_transfer_history.lua, confirmed by the user to run cleanly
-- against this exact game build) — same struct offsets, same
-- eastl::vector walk, just JSON output instead of a CSV on Desktop. It
-- only ever iterates the transfer manager's own small in-memory
-- negotiation vectors (everything it's CURRENTLY holding — a handful to a
-- few dozen entries, reset by the game itself every season), never a
-- whole-game-world DB table, so it doesn't share the crashed table's risk
-- profile.
--
-- Bounds-checked 2026-08-30: this code's very first live run (wired into
-- export_all.lua) hung silently — no crash, no error, the F10 script just
-- never finished, so calendar/league stats never synced either — because
-- an invalid mBegin/mEnd pair turned an eastl::vector walk into a loop
-- over garbage memory that never terminated. walk_negotiation_vector below
-- centralizes the null/bounds/iteration-cap guards that fix that.
--
-- Mirrored into export_all.lua's TRANSFERS EXPORT block — if you edit the
-- logic here, mirror the change there too (see that file's header).
-- ============================================================

local json_path = "C:\\Users\\Public\\ea_fc_transfers_export.json"
local BIG_MONEY_THRESHOLD = 60000000

local function convertFifaDate(dayOffset)
    if not dayOffset or dayOffset <= 0 then return "" end
    local baseEpochSeconds = -12219292800
    local targetSeconds = baseEpochSeconds + (dayOffset * 86400)
    return os.date("%m-%d-%Y", targetSeconds) or tostring(dayOffset)
end

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

-- club_negos holds the actual fee (keyed by "T<playerid>-<buyingteam>-
-- <sellingteam>" for transfers/exchanges, "L..." for loans) — a SEPARATE
-- negotiation-storage section from player_negos, which holds who/when/
-- what-type. Every get_succeeded_* function below just fills in one or
-- the other; get_transfer_data() joins them by that key, same two-pass
-- approach as the reference script.

-- Bounds-checked eastl::vector walk shared by every get_succeeded_* below
-- — see this file's header for why every guard here exists.
local MAX_NEGOTIATION_ENTRIES = 2000

local function walk_negotiation_vector(storage, vec_offset, obj_size, visit)
    if not storage or storage == 0 then return end
    local vec = MEMORY:ReadPointer(storage + vec_offset)
    if not vec or vec == 0 then return end
    local mBegin = MEMORY:ReadPointer(vec + 0x0)
    local mEnd = MEMORY:ReadPointer(vec + 0x8)
    if not mBegin or not mEnd or mBegin == 0 or mEnd == 0 or mEnd < mBegin then return end
    local current = mBegin
    local iterations = 0
    while current < mEnd and iterations < MAX_NEGOTIATION_ENTRIES do
        visit(current)
        current = current + obj_size
        iterations = iterations + 1
    end
end

local function get_succeeded_ai_club_transfers(out, storage)
    walk_negotiation_vector(storage, 0x8, 0xB8, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local seller_accepted = MEMORY:ReadBool(current + 0x6E)
            local buyer_accepted = MEMORY:ReadBool(current + 0x6F)
            if (seller_accepted or buyer_accepted) then
                local final_fee = 0
                local exchange_value = 0
                if seller_accepted then
                    final_fee = MEMORY:ReadInt(MEMORY:ReadPointer(current + 0x28) - 0xC)
                else
                    local mLastReq = MEMORY:ReadPointer(current + 0x48)
                    final_fee = MEMORY:ReadInt(mLastReq - 0x14 + 0x0)
                    exchange_value = MEMORY:ReadInt(mLastReq - 0x14 + 0x4)
                end
                local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                out[key] = { final_fee = final_fee, exchange_value = exchange_value }
            end
        end
    end)
end

local function get_succeeded_user_club_transfers(out, storage)
    walk_negotiation_vector(storage, 0x28, 0xA0, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local mActionsBegin = MEMORY:ReadPointer(current + 0x58)
            local mActionsEnd = MEMORY:ReadPointer(current + 0x60)
            if (mActionsBegin ~= mActionsEnd) then
                local last_action = MEMORY:ReadChar(mActionsEnd - 0xC + 0x8)
                local seller_accepted = last_action == 0
                local buyer_accepted = last_action == 4
                if (seller_accepted or buyer_accepted) then
                    local final_fee = 0
                    local exchange_value = 0
                    local exchange_player = 0
                    if seller_accepted then
                        local mLastOff = MEMORY:ReadPointer(current + 0x20)
                        exchange_player = MEMORY:ReadInt(mLastOff - 0x28 + 0x0)
                        exchange_value = MEMORY:ReadInt(mLastOff - 0x28 + 0x4)
                        final_fee = MEMORY:ReadInt(mLastOff - 0x28 + 0xC)
                    else
                        local mLastReq = MEMORY:ReadPointer(current + 0x40)
                        exchange_player = MEMORY:ReadInt(mLastReq - 0x28 + 0x0)
                        exchange_value = MEMORY:ReadInt(mLastReq - 0x28 + 0x4)
                        final_fee = MEMORY:ReadInt(mLastReq - 0x28 + 0xC)
                    end
                    local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                    out[key] = { final_fee = final_fee, exchange_player = exchange_player, exchange_value = exchange_value }
                end
            end
        end
    end)
end

local function get_succeeded_ai_player_transfers(out, storage)
    walk_negotiation_vector(storage, 0x10, 0xB0, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local seller_accepted = MEMORY:ReadBool(current + 0x67)
            if (seller_accepted) then
                local last_action_idx = MEMORY:ReadChar(current + 0x6C)
                local last_action_date = MEMORY:ReadInt(current + 0x70 + (0xC * (last_action_idx)))
                local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                out[key] = { playerid = playerid, buying_team = buying_team, selling_team = selling_team, date = last_action_date, type = "transfer" }
            end
        end
    end)
end

local function get_succeeded_ai_player_exchanges(out, storage)
    walk_negotiation_vector(storage, 0x40, 0xA8, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local seller_accepted = MEMORY:ReadBool(current + 0x67)
            if (seller_accepted) then
                local last_action_idx = MEMORY:ReadChar(current + 0x6B)
                local last_action_date = MEMORY:ReadInt(current + 0x6C + (0xC * (last_action_idx - 1)))
                local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                out[key] = { playerid = playerid, buying_team = buying_team, selling_team = selling_team, date = last_action_date, type = "transfer" }
            end
        end
    end)
end

local function get_succeeded_user_player_transfers(out, storage)
    walk_negotiation_vector(storage, 0x38, 0x98, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local mActionsBegin = MEMORY:ReadPointer(current + 0x50)
            local mActionsEnd = MEMORY:ReadPointer(current + 0x58)
            if (mActionsBegin ~= mActionsEnd) then
                local last_action = MEMORY:ReadChar(mActionsEnd - 0xC + 0x8)
                local seller_accepted = last_action == 0
                local buyer_accepted = last_action == 4
                if (seller_accepted or buyer_accepted) then
                    local last_action_date = MEMORY:ReadInt(mActionsEnd - 0xC + 0x0)
                    local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                    out[key] = { playerid = playerid, buying_team = buying_team, selling_team = selling_team, date = last_action_date, type = "transfer" }
                end
            end
        end
    end)
end

local function get_succeeded_user_player_exchanges(out, storage)
    walk_negotiation_vector(storage, 0x48, 0x98, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local mActionsBegin = MEMORY:ReadPointer(current + 0x50)
            local mActionsEnd = MEMORY:ReadPointer(current + 0x58)
            if (mActionsBegin ~= mActionsEnd) then
                local last_action = MEMORY:ReadChar(mActionsEnd - 0xC + 0x8)
                local seller_accepted = last_action == 0
                local buyer_accepted = last_action == 4
                if (seller_accepted or buyer_accepted) then
                    local last_action_date = MEMORY:ReadInt(mActionsEnd - 0xC + 0x0)
                    local key = string.format("T%d-%d-%d", playerid, buying_team, selling_team)
                    out[key] = { playerid = playerid, buying_team = buying_team, selling_team = selling_team, date = last_action_date, type = "transfer" }
                end
            end
        end
    end)
end

local function get_succeeded_ai_player_loans(out, storage)
    walk_negotiation_vector(storage, 0x20, 0x98, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local seller_accepted = MEMORY:ReadBool(current + 0x52)
            if (seller_accepted) then
                local last_action_idx = MEMORY:ReadChar(current + 0x57)
                local last_action_date = MEMORY:ReadInt(current + 0x58 + (0xC * (last_action_idx - 1)))
                local key = string.format("L%d-%d-%d", playerid, buying_team, selling_team)
                out[key] = { playerid = playerid, buying_team = buying_team, selling_team = selling_team, date = last_action_date, type = "loan" }
            end
        end
    end)
end

local function get_succeeded_ai_club_loans(out, storage)
    walk_negotiation_vector(storage, 0x18, 0xB8, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local seller_accepted = MEMORY:ReadBool(current + 0x72)
            local buyer_accepted = MEMORY:ReadBool(current + 0x73)
            if (seller_accepted or buyer_accepted) then
                local key = string.format("L%d-%d-%d", playerid, buying_team, selling_team)
                out[key] = { final_fee = 0 }
            end
        end
    end)
end

local function get_succeeded_user_club_loans(out, storage)
    walk_negotiation_vector(storage, 0x30, 0xF8, function(current)
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if (playerid > 0 and buying_team > 0 and selling_team > 0) then
            local mActionsBegin = MEMORY:ReadPointer(current + 0x50)
            local mActionsEnd = MEMORY:ReadPointer(current + 0x58)
            if (mActionsBegin ~= mActionsEnd) then
                local last_action = MEMORY:ReadChar(mActionsEnd - 0xC + 0x8)
                local seller_accepted = last_action == 0
                local buyer_accepted = last_action == 4
                if (seller_accepted or buyer_accepted) then
                    local key = string.format("L%d-%d-%d", playerid, buying_team, selling_team)
                    out[key] = { final_fee = 0 }
                end
            end
        end
    end)
end

-- Graceful, not assert()'d — see export_all.lua's mirrored block for why.
local function get_transfer_data()
    local result = {}
    local user_team_id = GetUserTeamID()

    local ok, transfer_mgr = pcall(GetManagerObjByTypeId, ENUM_FCEGameModesFCECareerModeTransferManager)
    if not ok or not transfer_mgr or transfer_mgr == 0 then
        print("[CompanionApp] WARNING: Transfer Manager object not found — transfers export skipped this sync.")
        return result
    end

    local neg_storage = MEMORY:ReadPointer(transfer_mgr + 0x1DD0)

    local player_negos = {}
    local club_negos = {}

    get_succeeded_ai_player_transfers(player_negos, neg_storage)
    get_succeeded_ai_player_exchanges(player_negos, neg_storage)
    get_succeeded_ai_player_loans(player_negos, neg_storage)
    get_succeeded_user_player_transfers(player_negos, neg_storage)
    get_succeeded_user_player_exchanges(player_negos, neg_storage)

    get_succeeded_ai_club_transfers(club_negos, neg_storage)
    get_succeeded_ai_club_loans(club_negos, neg_storage)
    get_succeeded_user_club_transfers(club_negos, neg_storage)
    get_succeeded_user_club_loans(club_negos, neg_storage)

    for key, nego in pairs(player_negos) do
        local club_nego = club_negos[key] or {}
        local fee = club_nego.final_fee or 0
        local is_user = (nego.selling_team == user_team_id) or (nego.buying_team == user_team_id)

        table.insert(result, {
            player_id = nego.playerid,
            player_name = safe_player_name(nego.playerid),
            from_team_id = nego.selling_team,
            to_team_id = nego.buying_team,
            from_team = safe_team_name(nego.selling_team),
            to_team = safe_team_name(nego.buying_team),
            deal_type = nego.type,
            fee = fee,
            exchange_value = club_nego.exchange_value or 0,
            date = convertFifaDate(nego.date),
            is_user = is_user,
            is_big_money = fee > BIG_MONEY_THRESHOLD
        })
    end

    return result
end

local function serialize_to_json(transfers, save_uid)
    local parts = {}
    for i, t in ipairs(transfers) do
        parts[i] = string.format(
            '{"player_id":%d,"player_name":"%s","from_team_id":%d,"to_team_id":%d,"from_team":"%s","to_team":"%s","deal_type":"%s","fee":%d,"exchange_value":%d,"date":"%s","is_user":%s,"is_league":false,"is_big_money":%s}',
            t.player_id, tostring(t.player_name):gsub('"', '\\"'),
            t.from_team_id, t.to_team_id,
            tostring(t.from_team):gsub('"', '\\"'),
            tostring(t.to_team):gsub('"', '\\"'),
            t.deal_type,
            t.fee or 0, t.exchange_value or 0,
            t.date or "",
            tostring(t.is_user),
            tostring(t.is_big_money)
        )
    end
    return string.format('{"save_uid":"%s","transfers":[', save_uid:gsub('"', '\\"')) .. table.concat(parts, ",") .. ']}'
end

assert(IsInCM(), "Script must be executed in career mode")

local save_uid = GetSaveUID() or ""

-- pcall'd as a final safety net — walk_negotiation_vector's own guards
-- stop a bad vector from hanging, but a single bad pointer chase deeper
-- inside a record (e.g. the mLastReq/mLastOff dereferences above) could
-- still throw once. Catching it here just means an empty export instead
-- of an uncaught error.
local ok, transfers = pcall(get_transfer_data)
if not ok then
    print("[CompanionApp] WARNING: Transfer fee read failed (" .. tostring(transfers) .. ") — exporting empty.")
    transfers = {}
end

local file = io.open(json_path, "w+")
if file then
    file:write(serialize_to_json(transfers, save_uid))
    file:close()
    print(string.format("[CompanionApp] Exported %d transfer fee record(s) to %s", #transfers, json_path))
else
    print("[CompanionApp] ERROR: Could not open transfers output path.")
end
