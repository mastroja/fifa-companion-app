-- ============================================================
-- READ-ONLY DIAGNOSTIC -- run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT bind to a
-- hotkey, do NOT fold into any other script until this completes
-- cleanly and the data below looks sane against what the in-game
-- standings actually show.
--
-- Follow-up to inspect_league_table_schema.lua, which confirmed
-- "leagueteamlinks" is a real DB table (not the raw-memory standings
-- struct export_fixtures.lua/export_career_calendar.lua use) with
-- exactly the fields a league table needs: points, nummatchesplayed,
-- home/away wins/draws/losses/goals-for/against, currenttableposition,
-- teamid, leagueid, etc.
--
-- This is a DIFFERENT table from the one that crashed the game before
-- (see feedback-live-editor-data-safety project memory: the
-- unrelated "transfers" table), but the same class of operation --
-- row iteration via GetFirstRecord/GetNextValidRecord/
-- GetRecordFieldValue -- so it gets the same caution: capped record
-- count, incremental flush after every record, no per-row name
-- lookups (GetTeamName etc.) on this first pass, just raw field
-- values.
--
-- Output: C:\Users\Public\ea_fc_connected_career_leagueteamlinks_probe.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_connected_career_leagueteamlinks_probe.json"
local MAX_RECORDS = 200 -- generous but capped -- a single league's team count is normally well under this

local logFile = io.open(outPath, "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

local FIELDS = {
    "leagueid", "teamid", "currenttableposition", "previousyeartableposition",
    "points", "nummatchesplayed",
    "homewins", "homedraws", "homelosses", "homegf", "homega",
    "awaywins", "awaydraws", "awaylosses", "awaygf", "awayga",
    "lastgameresult", "teamform", "champion",
}

log("=== leagueteamlinks row probe started ===")

local tbl = LE.db:GetTable("leagueteamlinks")
if not tbl then
    log("ABORT: leagueteamlinks table handle is nil.")
    if logFile then logFile:close() end
    return
end
log("Table handle acquired OK.")

local count = 0
local rec = tbl:GetFirstRecord()
log("GetFirstRecord() returned: " .. tostring(rec))

while rec and rec > 0 and count < MAX_RECORDS do
    count = count + 1

    local row = {}
    for _, field in ipairs(FIELDS) do
        local ok, value = pcall(function() return tbl:GetRecordFieldValue(rec, field) end)
        row[field] = ok and value or nil
        if not ok then
            log("  FIELD READ FAILED on record " .. tostring(rec) .. " field '" .. field .. "': " .. tostring(value))
        end
    end

    log(string.format(
        "[%d] rec=%s leagueid=%s teamid=%s pos=%s pts=%s played=%s W-D-L(H)=%s-%s-%s W-D-L(A)=%s-%s-%s form=%s",
        count, tostring(rec), tostring(row.leagueid), tostring(row.teamid), tostring(row.currenttableposition),
        tostring(row.points), tostring(row.nummatchesplayed),
        tostring(row.homewins), tostring(row.homedraws), tostring(row.homelosses),
        tostring(row.awaywins), tostring(row.awaydraws), tostring(row.awaylosses),
        tostring(row.teamform)
    ))

    if count >= MAX_RECORDS then
        log("STOP: hit MAX_RECORDS cap (" .. MAX_RECORDS .. ") -- table has more rows than this run read.")
        break
    end

    rec = tbl:GetNextValidRecord()
end

log("")
log("=== Done. Total records read: " .. count .. ". No writes were made. ===")
if logFile then logFile:close() end
