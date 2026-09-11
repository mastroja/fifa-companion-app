-- ============================================================
-- MANUAL RUN ONLY -- Features -> Lua Engine -> paste -> execute.
--
-- Second, more careful attempt at testing CreatePlayer after the
-- first attempt (test_create_player.lua, DO NOT RUN) crashed the
-- game. Two things changed, both aimed at the most likely causes:
--
-- 1. ID: the first test used an absurd 9-digit ID (900000001) picked
--    purely to guarantee no collision. Real generated players in
--    this save are 6-digit (460004, 460007) -- an ID that far
--    outside the normal range may hit an unrelated engine
--    overflow/range bug, not a CreatePlayer problem per se. This
--    test uses 469999 -- still safely unused (checked below via
--    PlayerExists), but much closer to a realistic ID.
--
-- 2. Field set: the first test used a minimal 14-field table,
--    trusting DOC.MD's claim that "missing fields will be replaced
--    with lowest possible value by default". Given this project's
--    track record of documented behavior not matching reality, this
--    test instead uses DOC.MD's own full ~90-field worked example
--    verbatim (the "Jerzy Dudek" example under CreatePlayer),
--    swapping only the ID and name -- if Live Editor's own
--    documented example doesn't work, nothing will.
--
-- This can still crash the game. If it does, that's strong evidence
-- CreatePlayer itself is unsafe in this build regardless of inputs,
-- not just a bad first attempt -- see project-connected-career-
-- architecture memory either way.
--
-- Output: C:\Users\Public\ea_fc_connected_career_create_test_log.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_connected_career_create_test_log.json"
local TEST_ID = 469999

local logFile = io.open(outPath, "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

log("=== CreatePlayer isolated test v2 started ===")

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

log("PlayerExists(" .. TEST_ID .. ") confirmed false -- safe to create.")

-- DOC.MD's own CreatePlayer example field table, verbatim, with only
-- headassetid/birthdate/contractvaliduntil left untouched from the
-- original example (not worth risking new values) and the ID-linked
-- headassetid updated to match our TEST_ID like the original example
-- links it to its own playerid (44897 -> headassetid 44897).
local player_data = {
    skintypecode = "2", trait2 = "0", haircolorcode = "6", facialhairtypecode = "3",
    curve = "14", jerseystylecode = "0", agility = "68", tattooback = "0",
    accessorycode4 = "0", gksavetype = "0", positioning = "16", tattooleftarm = "0",
    hairtypecode = "150", standingtackle = "19", preferredposition3 = "-1", longpassing = "27",
    penalties = "24", animfreekickstartposcode = "0", isretiring = "0", longshots = "19",
    gkdiving = "86", interceptions = "22", shoecolorcode2 = "15", crossing = "14",
    potential = "86", gkreflexes = "90", finishingcode1 = "0", reactions = "84",
    composure = "50", vision = "52", contractvaliduntil = "2025", finishing = "13",
    dribbling = "14", slidingtackle = "18", accessorycode3 = "0", accessorycolourcode1 = "0",
    headtypecode = "2508", driref = "90", sprintspeed = "56", height = "187",
    hasseasonaljersey = "1", tattoohead = "0", preferredposition2 = "-1", strength = "73",
    shoetypecode = "1", birthdate = "142605", preferredposition1 = "0", tattooleftleg = "0",
    ballcontrol = "26", phypos = "85", shotpower = "59", trait1 = "268435456",
    socklengthcode = "0", weight = "78", hashighqualityhead = "0", gkglovetypecode = "1",
    tattoorightarm = "0", balance = "61", gender = "0", headassetid = tostring(TEST_ID),
    gkkicking = "78", defspe = "60", internationalrep = "4", shortpassing = "33",
    freekickaccuracy = "27", skillmoves = "0", faceposerpreset = "0", usercaneditname = "0",
    avatarpomid = "0", attackingworkrate = "0", finishingcode2 = "0", aggression = "42",
    acceleration = "62", paskic = "78", headingaccuracy = "11", iscustomized = "0",
    eyebrowcode = "0", runningcode2 = "0", modifier = "1", gkhandling = "83",
    eyecolorcode = "6", jerseysleevelengthcode = "1", accessorycolourcode3 = "0", accessorycode1 = "0",
    playerjointeamdate = "160139", headclasscode = "0", defensiveworkrate = "0", tattoofront = "0",
    nationality = "37", preferredfoot = "2", sideburnscode = "0", weakfootabilitytypecode = "3",
    jumping = "71", personality = "2", gkkickstyle = "3", stamina = "44",
    marking = "26", accessorycolourcode4 = "0", gkpositioning = "85", headvariation = "0",
    skillmoveslikelihood = "0", shohan = "83", skintonecode = "3", shortstyle = "0",
    overallrating = "86", smallsidedshoetypecode = "500", emotion = "2", runstylecode = "0",
    jerseyfit = "0", accessorycode2 = "0", shoedesigncode = "0", shoecolorcode1 = "0",
    hairstylecode = "0", bodytypecode = "5", animpenaltiesstartposcode = "0", pacdiv = "86",
    runningcode1 = "0", preferredposition4 = "-1", volleys = "13", accessorycolourcode2 = "0",
    tattoorightleg = "0", facialhaircolorcode = "3",
}

log("About to call CreatePlayer(" .. TEST_ID .. ", <" .. (function() local n=0 for _ in pairs(player_data) do n=n+1 end return n end)() .. " fields>)")

local createOk, created_playerid = pcall(CreatePlayer, TEST_ID, player_data)
if not createOk then
    log("CreatePlayer FAILED (threw a catchable error): " .. tostring(created_playerid))
    if logFile then logFile:close() end
    return
end

log("CreatePlayer returned: " .. tostring(created_playerid))

if created_playerid == 0 or created_playerid == nil then
    log("FAILED: CreatePlayer returned 0/nil -- check Live Editor's own log file for the real error.")
    if logFile then logFile:close() end
    return
end

local nameOk, nameErr = pcall(function()
    return InsertDBTableRow("editedplayernames", {
        playerid = tostring(created_playerid),
        firstname = "ZZTEST",
        surname = "PlayerV2",
        playerjerseyname = "ZZTESTV2",
    })
end)
log("InsertDBTableRow(editedplayernames) ok=" .. tostring(nameOk) .. " result=" .. tostring(nameErr))

local existsAfter = PlayerExists(created_playerid)
log("PlayerExists(" .. tostring(created_playerid) .. ") after create: " .. tostring(existsAfter))

local nameCheckOk, nameCheck = pcall(GetPlayerName, created_playerid)
log("GetPlayerName after create: ok=" .. tostring(nameCheckOk) .. " value=" .. tostring(nameCheck))

log("=== Done. Go check Live Editor's Free Agents list / in-game for player id " .. tostring(created_playerid) .. " (\"ZZTEST PlayerV2\") ===")
if logFile then logFile:close() end
