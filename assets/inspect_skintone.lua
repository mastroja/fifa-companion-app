-- ============================================================
-- READ-ONLY DIAGNOSTIC — run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT bind to F10,
-- do NOT fold into export_all.lua/export_squad.lua until confirmed.
--
-- Goal: the "players" table has a real "skintonecode" field (confirmed
-- via connected_career/test_create_player_v2.lua's CreatePlayer example,
-- which set skintonecode = "3" — but that's just DOC.MD's own worked
-- example value, not an explanation of what the numbers mean). Nothing
-- in Live Editor's docs or bundled scripts documents skintonecode's
-- value range or what each number looks like. This script dumps every
-- real player's name, nationality, overall rating, and skintonecode to
-- a CSV so the user can open it, search for players they recognize by
-- name/face, and manually work out what the codes correspond to.
--
-- Safety note: this is NOT the same risk category as the "transfers"
-- table incident (see feedback-live-editor-data-safety memory). The
-- "players" table is already fully iterated every single sync by
-- export_squad.lua/export_all.lua in production without issue —
-- skintonecode is just one more GetRecordFieldValue call on a record
-- that loop already reads ~40 other fields from. Still run manually
-- first per project convention, with a hard cap and pcall around every
-- field read, rather than folding straight into the F10 script.
--
-- Output: C:\Users\Public\ea_fc_skintone_probe.csv
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_skintone_probe.csv"
local MAX_RECORDS_SCANNED = 25000 -- comfortably covers the whole game's player pool

local file = io.open(outPath, "w")
if not file then
    print("[SkintoneProbe] FAILED to open output file: " .. outPath)
    return
end

file:write("playerid,name,nationality_id,skintonecode,headassetid,overallrating\n")
file:flush()

local players_table = LE.db:GetTable("players")
if not players_table then
    print("[SkintoneProbe] FAILED: could not get 'players' table.")
    file:close()
    return
end

local function csvField(v)
    local s = tostring(v)
    if s:find('[,"\n]') then
        s = '"' .. s:gsub('"', '""') .. '"'
    end
    return s
end

local rec = players_table:GetFirstRecord()
local scanned = 0
local written = 0

while rec and rec > 0 and scanned < MAX_RECORDS_SCANNED do
    scanned = scanned + 1

    local ok1, playerid = pcall(players_table.GetRecordFieldValue, players_table, rec, "playerid")
    if ok1 and playerid and playerid > 0 then
        local ok2, nationality_id = pcall(players_table.GetRecordFieldValue, players_table, rec, "nationality")
        local ok3, skintonecode = pcall(players_table.GetRecordFieldValue, players_table, rec, "skintonecode")
        local ok4, headassetid = pcall(players_table.GetRecordFieldValue, players_table, rec, "headassetid")
        local ok5, overallrating = pcall(players_table.GetRecordFieldValue, players_table, rec, "overallrating")
        local okName, name = pcall(GetPlayerName, playerid)

        local row = {
            csvField(playerid),
            csvField(okName and name or ""),
            csvField(ok2 and nationality_id or ""),
            csvField(ok3 and skintonecode or ""),
            csvField(ok4 and headassetid or ""),
            csvField(ok5 and overallrating or "")
        }
        file:write(table.concat(row, ",") .. "\n")
        written = written + 1

        if written % 500 == 0 then
            file:flush()
            print(string.format("[SkintoneProbe] progress: scanned %d, written %d", scanned, written))
        end
    end

    rec = players_table:GetNextValidRecord()
end

file:close()
print(string.format("[SkintoneProbe] Done. Scanned %d records, wrote %d rows to %s", scanned, written, outPath))
