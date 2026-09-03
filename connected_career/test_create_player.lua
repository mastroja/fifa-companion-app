-- ============================================================
-- DO NOT RUN -- CONFIRMED TO CRASH THE GAME (2026-09-03). Kept only
-- as a record of what was tried -- see feedback-live-editor-data-safety
-- and project-connected-career-architecture project memory. Live
-- Editor's own log showed execution stopped inside the
-- pcall(CreatePlayer, ...) call itself, with no error caught and no
-- further log output -- a native-level crash CreatePlayer causes in
-- this Live Editor build, not something this script did wrong.
-- CreatePlayer is unsafe to call here, period; do not try again with
-- different arguments or a different ID.
--
-- Original intent (isolated test of CreatePlayer before building the
-- real mirroring pipeline around it, using a deliberately unused test
-- ID so nothing real could collide) preserved below for reference.
-- ============================================================
--
-- Output: C:\Users\Public\ea_fc_connected_career_create_test_log.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_connected_career_create_test_log.json"
local TEST_ID = 900000001

local logFile = io.open(outPath, "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

log("=== CreatePlayer isolated test started ===")

if not IsInCM() then
    log("ABORT: not in career mode.")
    if logFile then logFile:close() end
    return
end

if PlayerExists(TEST_ID) then
    log("ABORT: test id " .. TEST_ID .. " already exists -- pick a different TEST_ID, don't overwrite whatever this is.")
    if logFile then logFile:close() end
    return
end

local player_data = {
    overallrating = "77",
    potential = "80",
    preferredposition1 = "0",
    preferredposition2 = "-1",
    preferredposition3 = "-1",
    preferredposition4 = "-1",
    birthdate = "142605",
    height = "180",
    weight = "75",
    preferredfoot = "2",
    nationality = "37",
    weakfootabilitytypecode = "3",
    skillmoves = "3",
    modifier = "0",
}

local createOk, created_playerid = pcall(CreatePlayer, TEST_ID, player_data)
if not createOk then
    log("CreatePlayer FAILED (threw an error): " .. tostring(created_playerid))
    if logFile then logFile:close() end
    return
end

log("CreatePlayer returned: " .. tostring(created_playerid))

if created_playerid == 0 or created_playerid == nil then
    log("FAILED: CreatePlayer returned 0/nil -- check the Live Editor log file for the real error, it writes one there per DOC.MD.")
    if logFile then logFile:close() end
    return
end

local nameOk, nameErr = pcall(function()
    return InsertDBTableRow("editedplayernames", {
        playerid = tostring(created_playerid),
        firstname = "ZZTEST",
        surname = "Player",
        playerjerseyname = "ZZTEST",
    })
end)
log("InsertDBTableRow(editedplayernames) ok=" .. tostring(nameOk) .. " result=" .. tostring(nameErr))

local existsAfter = PlayerExists(created_playerid)
log("PlayerExists(" .. tostring(created_playerid) .. ") after create: " .. tostring(existsAfter))

local nameCheckOk, nameCheck = pcall(GetPlayerName, created_playerid)
log("GetPlayerName after create: ok=" .. tostring(nameCheckOk) .. " value=" .. tostring(nameCheck))

log("=== Done. Go check Live Editor's Free Agents list / in-game for player id " .. tostring(created_playerid) .. " ===")
if logFile then logFile:close() end
