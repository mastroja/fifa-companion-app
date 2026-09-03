-- ============================================================
-- READ-ONLY -- run manually from Live Editor's Lua Engine.
--
-- Dumps the COMPLETE raw "players" table row (every field, read
-- dynamically via GetDBTableFields so nothing needs to be
-- hand-maintained) for each requested player_id, plus their name
-- from "editedplayernames" if they have one. This is the input
-- CreatePlayer(explicit_id, players_row_data) needs to recreate a
-- player with an identical ID+appearance+attributes in another
-- save -- see the project's connected-career-architecture memory on
-- why generated player IDs aren't stable across saves and mirroring
-- is the fix.
--
-- Read-only: only GetRecordFieldValue calls, no writes. Same
-- full-table-scan-for-target-ids pattern as apply_sync_updates.lua.
--
-- Input:  C:\Users\Public\ea_fc_connected_career_export_request.json
--         { "player_ids": [460007, 460004] }
-- Output: C:\Users\Public\ea_fc_connected_career_full_rows_export.json
-- ============================================================

require 'imports/other/helpers'
local json = require 'imports/external/json'

local inPath = "C:\\Users\\Public\\ea_fc_connected_career_export_request.json"
local outPath = "C:\\Users\\Public\\ea_fc_connected_career_full_rows_export.json"

local function readFile(path)
    local f = io.open(path, "r")
    if not f then return nil end
    local content = f:read("*a")
    f:close()
    return content
end

local logFile = io.open(outPath .. ".log.txt", "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

log("=== Full player row export started ===")

local raw = readFile(inPath)
if not raw then
    log("ABORT: no request file found at " .. inPath)
    if logFile then logFile:close() end
    return
end

local parseOk, request = pcall(json.decode, raw)
if not parseOk or not request or not request.player_ids then
    log("ABORT: request file did not parse as expected JSON. Error: " .. tostring(request))
    if logFile then logFile:close() end
    return
end

local targets = {}
for _, pid in ipairs(request.player_ids) do
    targets[pid] = true
end

-- Dynamic field list -- see GetDBTableFields in DOC.MD. Excludes
-- "playerid" itself since CreatePlayer takes that as a separate arg,
-- not part of players_row_data (matches the DOC.MD example, which
-- never puts playerid inside its own row-data table).
local players_table = LE.db:GetTable("players")
if not players_table then
    log("ABORT: players table handle is nil.")
    if logFile then logFile:close() end
    return
end

local fieldDescs = GetDBTableFields("players")
local fieldNames = {}
for _, desc in ipairs(fieldDescs) do
    if desc["name"] and desc["name"] ~= "playerid" then
        table.insert(fieldNames, desc["name"])
    end
end
log("players table has " .. #fieldNames .. " fields (excluding playerid).")

local names_table = LE.db:GetTable("editedplayernames")

local results = {}
local found = 0
local rec = players_table:GetFirstRecord()

while rec and rec > 0 do
    local pid = players_table:GetRecordFieldValue(rec, "playerid")
    if targets[pid] then
        found = found + 1
        local row = {}
        for _, fieldName in ipairs(fieldNames) do
            local ok, value = pcall(function() return players_table:GetRecordFieldValue(rec, fieldName) end)
            if ok then row[fieldName] = value end
        end

        local nameEntry = nil
        if names_table then
            local nrec = names_table:GetFirstRecord()
            while nrec and nrec > 0 do
                local npid = names_table:GetRecordFieldValue(nrec, "playerid")
                if npid == pid then
                    nameEntry = {
                        firstname = names_table:GetRecordFieldValue(nrec, "firstname"),
                        surname = names_table:GetRecordFieldValue(nrec, "surname"),
                        playerjerseyname = names_table:GetRecordFieldValue(nrec, "playerjerseyname"),
                    }
                    break
                end
                nrec = names_table:GetNextValidRecord()
            end
        end

        table.insert(results, { player_id = pid, players_row = row, name = nameEntry })
        log("Exported player_id " .. tostring(pid) .. " (" .. tostring(GetPlayerName(pid)) .. ") -- " .. #fieldNames .. " fields, name entry: " .. tostring(nameEntry ~= nil))
        targets[pid] = nil
    end
    rec = players_table:GetNextValidRecord()
end

for pid, _ in pairs(targets) do
    log("NOT FOUND: player_id " .. tostring(pid))
end

local outFile = io.open(outPath, "w")
if outFile then
    outFile:write(json.encode({ players = results }))
    outFile:close()
    log("Wrote " .. found .. " player row(s) to " .. outPath)
else
    log("ABORT: could not open output file for writing.")
end

log("=== Done. ===")
if logFile then logFile:close() end
