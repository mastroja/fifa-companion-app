-- ============================================================
-- READ-ONLY DIAGNOSTIC -- run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT fold into
-- apply_sync_updates.lua or any other script until whatever this
-- finds is confirmed safe and useful.
--
-- Goal: check whether a table matching "leagueteamlinks" (or any
-- similarly-named table -- "league", "standing", "table",
-- "competition") actually exists in this save's DB, and if so, what
-- fields it has -- e.g. whether it looks like real live standings
-- (wins/draws/losses/points/goals) or just team-to-competition
-- membership (which wouldn't help write the table directly).
--
-- SCHEMA ONLY -- this never touches row data. It only calls
-- GetDBTablesNames() and GetDBTableFields(), never GetTable(x):
-- GetFirstRecord()/GetNextValidRecord()/GetRecordFieldValue(). That
-- row-iteration step is what crashed the game on the unrelated
-- "transfers" table before (see feedback-live-editor-data-safety
-- project memory) -- listing table/field names carries none of that
-- risk and has already been done safely in this project before (see
-- reference-live-editor-install memory, the playerperks/archetypes
-- schema dump).
--
-- Output: C:\Users\Public\ea_fc_connected_career_league_table_schema_probe.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_connected_career_league_table_schema_probe.json"
local KEYWORDS = { "league", "standing", "table", "competition" }

local function jsonEscape(s)
    return tostring(s):gsub('[\\"]', '\\%0')
end

local logFile = io.open(outPath, "w")
local function log(line)
    Log(line)
    if logFile then
        logFile:write(line .. "\n")
        logFile:flush()
    end
end

local function matchesKeyword(name)
    local lower = string.lower(name)
    for _, kw in ipairs(KEYWORDS) do
        if string.find(lower, kw, 1, true) then
            return true
        end
    end
    return false
end

log("=== League table schema probe started ===")

local allTables = GetDBTablesNames()
log("Total DB tables in this save: " .. tostring(#allTables))

local matches = {}
for _, tableName in ipairs(allTables) do
    if matchesKeyword(tableName) then
        table.insert(matches, tableName)
    end
end

log("Tables matching keywords (league/standing/table/competition): " .. tostring(#matches))
for _, name in ipairs(matches) do
    log("  - " .. name)
end

for _, tableName in ipairs(matches) do
    log("")
    log("--- Fields for '" .. tableName .. "' ---")
    local ok, fields = pcall(GetDBTableFields, tableName)
    if not ok then
        log("  ERROR reading fields: " .. tostring(fields))
    elseif not fields then
        log("  (no fields returned)")
    else
        -- DOC.MD only confirms fields[i]["name"] as a documented key
        -- (see GetDBTableFields example) -- not guessing at anything else.
        for _, field in ipairs(fields) do
            log("  " .. jsonEscape(field["name"]))
        end
    end
end

log("")
log("=== Done. No rows were read or written -- schema only. ===")
if logFile then logFile:close() end
