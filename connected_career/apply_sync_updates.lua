-- ============================================================
-- CONNECTED CAREER -- SYNC WRITE-BACK (app -> game)
--
-- MANUAL RUN ONLY -- Features -> Lua Engine -> paste -> execute.
-- Do NOT bind this to F10 or any other hotkey until it has been
-- run manually many times with no crash. This is the first
-- write-direction script this project has ever shipped; every
-- other *.lua file in the app (see assets/) only reads the game
-- into JSON. This one lives in connected_career/ instead of
-- assets/ since it's part of the Connected Career feature, not
-- the base app's regular squad/calendar/transfer exports.
--
-- This is the reverse of export_all.lua: it reads a JSON file the
-- companion app wrote (queued player-attribute changes pulled in
-- from a synced career) and applies them to THIS save.
--
-- REVISION 2026-09-03: the first version of this script only called
-- PlayerSetValueInDevelopementPlan, Live Editor's documented
-- "sanctioned" API for this. Tested against a real player
-- (composure=99, then an extreme composure=999999) with no error
-- reported either time, but ZERO observable effect in Live Editor
-- or the actual running game. Found the real mechanism by reading
-- Live Editor's own bundled 99ovr_99pot.lua example script: it
-- writes the RAW "players" table field directly via
-- players_table:SetRecordFieldValue(record, field, value) (a T3DB
-- table method, not in DOC.MD's function list at all) for every
-- player, and ONLY ALSO calls PlayerSetValueInDevelopementPlan for
-- players who have a development plan -- doing both, not the dev
-- plan call alone. It also clears the "modifier" field to 0 after
-- editing attributes ("to not affect his ovr"), so this script does
-- too. This is the same class of write as the documented
-- EditDBTableField (per-field DB table write), not a raw memory
-- poke, and this project's own export_squad.lua already safely
-- fully iterates this exact "players" table on every F10 refresh --
-- a different table/operation than the "transfers" table that
-- crashed the game before (see feedback-live-editor-data-safety
-- project memory).
--
-- Input:  C:\Users\Public\ea_fc_connected_career_pending_writes.json
--         { "players": [ { "player_id": 158023,
--                           "attributes": { "composure": 99, ... } } ] }
-- Output: C:\Users\Public\ea_fc_connected_career_write_log.json
--         (plain text log, one line per step, flushed after every
--         player so a crash mid-run still shows exactly how far it got)
-- ============================================================

require 'imports/other/helpers'
local json = require 'imports/external/json'

local inPath = "C:\\Users\\Public\\ea_fc_connected_career_pending_writes.json"
local outPath = "C:\\Users\\Public\\ea_fc_connected_career_write_log.json"
local MAX_PLAYERS_PER_RUN = 25 -- hard cap, matches project safety protocol

local function readFile(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return content
end

local logFile = io.open(outPath, "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

log("=== Connected Career write-back started ===")

if not IsInCM() then
    log("ABORT: not in career mode.")
    if logFile then logFile:close() end
    return
end

local raw = readFile(inPath)
if not raw then
    log("ABORT: no pending-writes file found at " .. inPath)
    if logFile then logFile:close() end
    return
end

local parseOk, data = pcall(json.decode, raw)
if not parseOk or not data or not data.players then
    log("ABORT: pending-writes file did not parse as expected JSON. Error: " .. tostring(data))
    if logFile then logFile:close() end
    return
end

-- Build a lookup of the players we actually want to touch, capped, so we
-- only need one pass over the "players" table instead of one pass per
-- queued player.
local targets = {}
local queuedCount = 0
for _, playerUpdate in ipairs(data.players) do
    if queuedCount >= MAX_PLAYERS_PER_RUN then
        log("STOP QUEUEING: hit MAX_PLAYERS_PER_RUN cap (" .. MAX_PLAYERS_PER_RUN .. "). Remaining entries in the file were left untouched this run -- run the script again to continue.")
        break
    end
    if playerUpdate.player_id then
        targets[playerUpdate.player_id] = playerUpdate
        queuedCount = queuedCount + 1
    end
end

local players_table = LE.db:GetTable("players")
if not players_table then
    log("ABORT: players table handle is nil.")
    if logFile then logFile:close() end
    return
end

local applied = 0
local rec = players_table:GetFirstRecord()

while rec and rec > 0 do
    local pid = players_table:GetRecordFieldValue(rec, "playerid")
    local update = targets[pid]

    if update then
        local hasDevPlanOk, hasDevPlan = pcall(PlayerHasDevelopementPlan, pid)
        hasDevPlan = hasDevPlanOk and hasDevPlan

        local fieldsApplied = 0
        for fieldName, value in pairs(update.attributes or {}) do
            local rawOk, rawErr = pcall(function()
                players_table:SetRecordFieldValue(rec, fieldName, value)
            end)
            if rawOk then
                fieldsApplied = fieldsApplied + 1
            else
                log("  RAW FIELD FAILED: player_id " .. tostring(pid) .. " field '" .. tostring(fieldName) .. "' -> " .. tostring(value) .. " error: " .. tostring(rawErr))
            end

            if hasDevPlan then
                local devOk, devErr = pcall(PlayerSetValueInDevelopementPlan, pid, fieldName, value)
                if not devOk then
                    log("  DEV PLAN FIELD FAILED: player_id " .. tostring(pid) .. " field '" .. tostring(fieldName) .. "' -> " .. tostring(value) .. " error: " .. tostring(devErr))
                end
            end
        end

        -- Matches 99ovr_99pot.lua's own pattern -- clears a multiplier
        -- field that could otherwise skew the computed rating away from
        -- the raw attributes we just wrote.
        pcall(function() players_table:SetRecordFieldValue(rec, "modifier", 0) end)

        log("APPLIED: player_id " .. tostring(pid) .. " (" .. tostring(GetPlayerName(pid)) .. ") -- " .. fieldsApplied .. " field(s) written. hasDevPlan=" .. tostring(hasDevPlan))
        applied = applied + 1
        targets[pid] = nil
    end

    rec = players_table:GetNextValidRecord()
end

-- Anything left in targets wasn't found in the players table at all.
local notFound = 0
for pid, _ in pairs(targets) do
    log("SKIP: player_id " .. tostring(pid) .. " not found in the players table.")
    notFound = notFound + 1
end

log("=== Done. queued=" .. queuedCount .. " applied=" .. applied .. " not_found=" .. notFound .. " ===")
if logFile then logFile:close() end
