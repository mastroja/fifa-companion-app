-- ============================================================
-- CONNECTED CAREER -- MIRROR CREATE (app -> game)
--
-- MANUAL RUN ONLY -- Features -> Lua Engine -> paste -> execute.
-- Do NOT bind to a hotkey. See test_create_player_v3.lua and the
-- project's connected-career-architecture memory for how CreatePlayer
-- was confirmed safe (needs a real, captured headassetid -- an
-- invented one crashes the game ~14s after creation, not during the
-- call itself).
--
-- ID RESOLUTION -- the actual point of this script's redesign:
-- generated-player IDs are confirmed to collide systematically across
-- independently-started saves (both saves generate their first youth
-- intake into roughly the same id range -- see project memory). For
-- each incoming player, this resolves where it should actually live
-- in THIS save, in order:
--   1. DIRECT: if the source id doesn't already exist here, use it
--      as-is (covers real licensed players, who already share the
--      same id everywhere, and any generated player that happens not
--      to collide).
--   2. ALREADY PRESENT: if the source id already exists here AND its
--      name matches the incoming player's name, treat it as already
--      the same player (e.g. a real player, or one mirrored before)
--      -- no create needed, just record the identity mapping.
--   3. OFFSET: if the source id exists here but belongs to someone
--      else entirely (a genuine collision, e.g. the Sebastian Nixon
--      situation), add 100000 and check again, escalating up to 3
--      times, using the first free id found. This is the user's own
--      "encrypt/decrypt by a fixed offset" idea from project
--      discussion -- deliberately staying in the SAME digit-count/
--      magnitude as real generated ids (not a huge invented number),
--      since only that range has actually been proven safe with
--      CreatePlayer.
--
-- Every resolution is written to the results file so the Node side
-- can persist the REAL mapping (source_id -> local_id) to Firebase --
-- this is the only place that mapping can be determined, since only
-- Lua can call PlayerExists/GetPlayerName against the live save.
-- Ongoing attribute sync (apply_sync_updates.lua) should only ever
-- target ids that have gone through this mapping, never a raw,
-- unverified source id.
--
-- Input:  C:\Users\Public\ea_fc_connected_career_pending_mirror_creates.json
--         { "players": [ { "player_id": 460007,
--                           "players_row": { <~90 raw fields> },
--                           "name": { "firstname": "...", "surname": "...", "playerjerseyname": "..." } } ] }
-- Output: C:\Users\Public\ea_fc_connected_career_mirror_create_log.json (log)
--         C:\Users\Public\ea_fc_connected_career_mirror_create_results.json
--         { "460007": 460007, "460004": 560004 } -- source_id -> local_id
-- ============================================================

local inPath = "C:\\Users\\Public\\ea_fc_connected_career_pending_mirror_creates.json"
local outPath = "C:\\Users\\Public\\ea_fc_connected_career_mirror_create_log.json"
local resultsPath = "C:\\Users\\Public\\ea_fc_connected_career_mirror_create_results.json"
local MAX_PLAYERS_PER_RUN = 10 -- lower than the attribute-write cap -- this is newer, higher-stakes functionality
local MIRROR_OFFSET = 100000
local MAX_OFFSET_ATTEMPTS = 3

require 'imports/other/helpers'
local json = require 'imports/external/json'

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

log("=== Mirror create started ===")

if not IsInCM() then
    log("ABORT: not in career mode.")
    if logFile then logFile:close() end
    return
end

local raw = readFile(inPath)
if not raw then
    log("ABORT: no pending-mirror-creates file found at " .. inPath)
    if logFile then logFile:close() end
    return
end

local parseOk, data = pcall(json.decode, raw)
if not parseOk or not data or not data.players then
    log("ABORT: pending-mirror-creates file did not parse as expected JSON. Error: " .. tostring(data))
    if logFile then logFile:close() end
    return
end

-- Returns targetId, resolution ("direct"|"already_present"|"offset"|nil)
local function resolveTargetId(sourceId, incomingName)
    if not PlayerExists(sourceId) then
        return sourceId, "direct"
    end

    local existingOk, existingName = pcall(GetPlayerName, sourceId)
    local incomingFullName = nil
    if incomingName then
        incomingFullName = (incomingName.firstname or "") .. " " .. (incomingName.surname or "")
    end
    if existingOk and incomingFullName and existingName == incomingFullName then
        return sourceId, "already_present"
    end

    for attempt = 1, MAX_OFFSET_ATTEMPTS do
        local candidate = sourceId + (MIRROR_OFFSET * attempt)
        if not PlayerExists(candidate) then
            return candidate, "offset"
        end
    end
    return nil, "exhausted"
end

local processed = 0
local created = 0
local alreadyPresent = 0
local failed = 0
local results = {}

for _, entry in ipairs(data.players) do
    if processed >= MAX_PLAYERS_PER_RUN then
        log("STOP: hit MAX_PLAYERS_PER_RUN cap (" .. MAX_PLAYERS_PER_RUN .. "). Remaining players left untouched this run -- run again to continue.")
        break
    end
    processed = processed + 1

    local pid = entry.player_id
    if not pid then
        log("SKIP: entry #" .. processed .. " has no player_id.")
    else
        local targetId, resolution = resolveTargetId(pid, entry.name)

        if resolution == "exhausted" then
            log("FAILED: source player_id " .. tostring(pid) .. " -- collided at every offset attempt (up to +" .. (MIRROR_OFFSET * MAX_OFFSET_ATTEMPTS) .. "), giving up. Not created.")
            failed = failed + 1
        elseif resolution == "already_present" then
            log("ALREADY PRESENT: source player_id " .. tostring(pid) .. " matches an existing player here (" .. tostring(GetPlayerName(pid)) .. ") by name -- no create needed, mapping recorded as identity.")
            results[tostring(pid)] = targetId
            alreadyPresent = alreadyPresent + 1
        else
            local createOk, created_playerid = pcall(CreatePlayer, targetId, entry.players_row or {})
            if not createOk then
                log("FAILED: source player_id " .. tostring(pid) .. " (target " .. tostring(targetId) .. ") CreatePlayer threw: " .. tostring(created_playerid))
                failed = failed + 1
            elseif created_playerid == 0 or created_playerid == nil then
                log("FAILED: source player_id " .. tostring(pid) .. " (target " .. tostring(targetId) .. ") CreatePlayer returned 0/nil.")
                failed = failed + 1
            else
                local nameLogged = "no name entry"
                if entry.name then
                    local nameOk, nameErr = pcall(function()
                        return InsertDBTableRow("editedplayernames", {
                            playerid = tostring(created_playerid),
                            firstname = entry.name.firstname or "",
                            surname = entry.name.surname or "",
                            playerjerseyname = entry.name.playerjerseyname or "",
                        })
                    end)
                    nameLogged = "name insert ok=" .. tostring(nameOk) .. (nameOk and "" or (" err=" .. tostring(nameErr)))
                end
                local tag = (resolution == "offset") and (" [OFFSET -- source " .. tostring(pid) .. " collided]") or ""
                log("CREATED: player_id " .. tostring(created_playerid) .. tag .. " (" .. nameLogged .. ")")
                results[tostring(pid)] = created_playerid
                created = created + 1
            end
        end
    end
end

local resultsFile = io.open(resultsPath, "w")
if resultsFile then
    resultsFile:write(json.encode(results))
    resultsFile:close()
    log("Wrote resolved mapping for " .. created + alreadyPresent .. " player(s) to " .. resultsPath)
end

log("=== Done. processed=" .. processed .. " created=" .. created .. " already_present=" .. alreadyPresent .. " failed=" .. failed .. " ===")
if created > 0 then
    log("Players were created -- WAIT roughly 30 seconds before doing anything else, watching for a delayed crash -- see project memory on why.")
end
if logFile then logFile:close() end
