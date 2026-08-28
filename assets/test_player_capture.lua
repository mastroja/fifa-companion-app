-- ============================================================
-- ONE-OFF DIAGNOSTIC — not part of export_all.lua / F10.
-- Run this manually via Live Editor's Lua Engine (Features -> Lua Engine
-- -> Execute, load this file and run it) while a career save is loaded.
--
-- Tests Live Editor's documented but never-before-used PlayerCapture*
-- API (PlayerCaptureSetOutputDirectory/SetCamera/SetSize/SetType/
-- AddPlayer/Start) — generates a real head-shot PNG per player, which
-- would let the companion app show actual player photos instead of the
-- generic silhouette placeholder.
--
-- Per this project's Live Editor safety protocol (a previous "documented
-- and should be safe" API call — reading the real `transfers` table —
-- crashed the game outright), this is tested here in isolation FIRST,
-- capped to just 2 of your own squad's players, before anything touches
-- export_all.lua. Do NOT bind this script to F10.
--
-- Output: %USERPROFILE%\Desktop\LE_capture_test.txt (progress log,
-- flushed after every step so a crash still shows how far it got) plus
-- whatever image files Live Editor itself writes to its default output
-- directory (see the log for exactly where — the app-facing doc's
-- example default is <Live Editor install>\mods\root\Legacy\data\ui\
-- imgAssets\heads, but that hasn't been confirmed for this FC26 build).
-- ============================================================
require 'imports/other/helpers'

assert(IsInCM(), "Script must be executed in career mode")

local desktop_path = string.format("%s\\Desktop", os.getenv('USERPROFILE'))
local out_path = desktop_path .. "\\LE_capture_test.txt"
local file = io.open(out_path, "w+")
io.output(file)

local function log(msg)
    io.write(msg .. "\n")
    io.flush()
end

log("1. Starting PlayerCapture diagnostic.")

local user_team_id = GetUserTeamID()
log("2. GetUserTeamID() = " .. tostring(user_team_id))
if not user_team_id or user_team_id <= 0 then
    log("ABORT: no valid user team id, can't pick test players.")
    io.close(file)
    return
end

-- Collect just 2 of the user's own squad players (same safe
-- players_table walk export_all.lua already uses) — capped low since
-- this is an unverified API and each capture reportedly takes ~2s.
local players_table = LE.db:GetTable("players")
local test_players = {}
local record = players_table:GetFirstRecord()
while record > 0 and #test_players < 2 do
    local playerid = players_table:GetRecordFieldValue(record, "playerid")
    if playerid and playerid > 0 then
        local team_id = GetTeamIdFromPlayerId(playerid)
        if team_id == user_team_id then
            local pos = players_table:GetRecordFieldValue(record, "preferredposition1")
            table.insert(test_players, { id = playerid, name = GetPlayerName(playerid), is_gk = (pos == 0) })
        end
    end
    record = players_table:GetNextValidRecord()
end
log("3. Collected " .. #test_players .. " test player(s):")
for i, p in ipairs(test_players) do
    log("   - " .. p.id .. " (" .. tostring(p.name) .. ")")
end
if #test_players == 0 then
    log("ABORT: found no squad players to test with.")
    io.close(file)
    return
end

-- Switched from "<default>" to an explicit, pre-created directory inside
-- the actual game install folder — "<default>" produced no findable
-- output file anywhere (checked both the Live Editor mods mirror and the
-- real game install), so this removes the guesswork about where
-- "<default>" actually resolves to in this build.
log("4. Calling PlayerCaptureSetOutputDirectory('companion_head_capture')...")
local ok1, err1 = pcall(PlayerCaptureSetOutputDirectory, "companion_head_capture")
log("   -> ok=" .. tostring(ok1) .. (err1 and (" err=" .. tostring(err1)) or ""))

log("5. Calling PlayerCaptureSetCamera(0) [head and shoulders]...")
local ok2, err2 = pcall(PlayerCaptureSetCamera, 0)
log("   -> ok=" .. tostring(ok2) .. (err2 and (" err=" .. tostring(err2)) or ""))

log("6. Calling PlayerCaptureSetSize(256, 256)...")
local ok3, err3 = pcall(PlayerCaptureSetSize, 256, 256)
log("   -> ok=" .. tostring(ok3) .. (err3 and (" err=" .. tostring(err3)) or ""))

log("7. Calling PlayerCaptureSetType(0) [PNG]...")
local ok4, err4 = pcall(PlayerCaptureSetType, 0)
log("   -> ok=" .. tostring(ok4) .. (err4 and (" err=" .. tostring(err4)) or ""))

for i, p in ipairs(test_players) do
    log("8." .. i .. " Calling PlayerCaptureAddPlayer(" .. p.id .. ", " .. user_team_id .. ", " .. tostring(p.is_gk) .. ")...")
    local ok5, err5 = pcall(PlayerCaptureAddPlayer, p.id, user_team_id, p.is_gk)
    log("   -> ok=" .. tostring(ok5) .. (err5 and (" err=" .. tostring(err5)) or ""))
end

log("9. Calling PlayerCaptureStart() — this is the step that actually generates images, may take a few seconds...")
local ok6, err6 = pcall(PlayerCaptureStart)
log("   -> ok=" .. tostring(ok6) .. (err6 and (" err=" .. tostring(err6)) or ""))

log("10. PlayerCaptureStart() returned successfully — if the game is still running and reading this, the capture completed without crashing.")
log("    Check the default output directory mentioned in Live Editor's docs, and report back what you find (or don't find).")

io.close(file)
LOGGER:LogInfo("EA FC Companion: PlayerCapture diagnostic complete, see " .. out_path)
