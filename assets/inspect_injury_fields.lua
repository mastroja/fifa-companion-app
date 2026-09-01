-- ============================================================
-- READ-ONLY DIAGNOSTIC — run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT bind to F10,
-- do NOT fold into export_all.lua/export_squad.lua until the fields
-- found here are confirmed safe and useful.
--
-- Goal: the companion app currently only reads the boolean "injury"
-- field from the "teamplayerlinks" table (see export_all.lua /
-- export_squad.lua). Live Editor's own built-in Player Editor shows
-- richer injury info (type, duration) somewhere -- this script finds
-- out where by:
--   1. Listing every DB table whose name mentions "injur" (in case
--      there's a dedicated injury table we've never looked at).
--   2. Dumping the FULL field list of "teamplayerlinks" (we currently
--      only read a handful of its columns -- injury type/duration may
--      already be sitting in a column we've never selected).
--   3. Iterating "teamplayerlinks" (already safe -- export_all.lua and
--      export_squad.lua fully iterate this table in production every
--      run) to find a handful of currently-injured players, and
--      dumping ALL of their field values so we can see real data next
--      to the injury flag, not just column names.
--
-- This only uses the high-level schema/record API (GetDBTablesNames,
-- GetDBTableFields, GetTable/GetFirstRecord/GetNextValidRecord/
-- GetRecordFieldValue) -- no raw memory reads, and no touching of the
-- "transfers" table (confirmed unsafe/crashes -- see project memory).
--
-- Output: C:\Users\Public\ea_fc_injury_fields_probe.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_injury_fields_probe.json"
local MAX_RECORDS_SCANNED = 5000 -- hard cap, matches project safety protocol
local MAX_INJURED_SAMPLES = 5

local function jsonEscape(s)
    return tostring(s):gsub('[\\"]', '\\%0')
end
local function jsonValue(v)
    if v == nil then return "null" end
    local t = type(v)
    if t == "number" then return tostring(v) end
    if t == "boolean" then return tostring(v) end
    if t == "string" then return '"' .. jsonEscape(v) .. '"' end
    if t == "table" then
        local isArray = true
        local n = 0
        for k, _ in pairs(v) do
            n = n + 1
            if type(k) ~= "number" then isArray = false end
        end
        if isArray and n > 0 then
            local parts = {}
            for i = 1, n do parts[i] = jsonValue(v[i]) end
            return "[" .. table.concat(parts, ",") .. "]"
        else
            local parts = {}
            for k, val in pairs(v) do
                table.insert(parts, string.format('"%s":%s', jsonEscape(k), jsonValue(val)))
            end
            return "{" .. table.concat(parts, ",") .. "}"
        end
    end
    return "null"
end

local file = io.open(outPath, "w")
if not file then
    print("[InjuryFieldsProbe] FAILED to open output file: " .. outPath)
    return
end

local result = {}

-- ---- 1. Any DB table whose name mentions "injur" ----
local injuryTableNames = {}
local ok1, allTableNames = pcall(GetDBTablesNames)
if ok1 and allTableNames then
    for _, name in ipairs(allTableNames) do
        if type(name) == "string" and name:lower():find("injur") then
            table.insert(injuryTableNames, name)
        end
    end
end
result.injury_named_tables = injuryTableNames
file:write('{"injury_named_tables":' .. jsonValue(injuryTableNames) .. ",\n")
file:flush()

-- ---- 2. Full field list of teamplayerlinks ----
local tplFieldNames = {}
local ok2, tplFields = pcall(GetDBTableFields, "teamplayerlinks")
if ok2 and tplFields then
    for _, f in ipairs(tplFields) do
        table.insert(tplFieldNames, f.name)
    end
end
file:write('"teamplayerlinks_fields":' .. jsonValue(tplFieldNames) .. ",\n")
file:flush()

-- ---- 3. Sample full records for currently-injured players ----
local injuredSamples = {}
local teamplayerlinks_table = LE.db:GetTable("teamplayerlinks")
if teamplayerlinks_table and #tplFieldNames > 0 then
    local rec = teamplayerlinks_table:GetFirstRecord()
    local scanned = 0
    while rec and rec > 0 and scanned < MAX_RECORDS_SCANNED and #injuredSamples < MAX_INJURED_SAMPLES do
        scanned = scanned + 1
        local ok3, injuryVal = pcall(teamplayerlinks_table.GetRecordFieldValue, teamplayerlinks_table, rec, "injury")
        if ok3 and injuryVal and injuryVal ~= 0 then
            local sample = {}
            for _, fname in ipairs(tplFieldNames) do
                local ok4, val = pcall(teamplayerlinks_table.GetRecordFieldValue, teamplayerlinks_table, rec, fname)
                sample[fname] = ok4 and val or "READ_FAILED"
            end
            table.insert(injuredSamples, sample)
        end
        rec = teamplayerlinks_table:GetNextValidRecord()
        if scanned % 500 == 0 then
            print(string.format("[InjuryFieldsProbe] progress: scanned %d records", scanned))
        end
    end
    result.records_scanned = scanned
end

file:write('"injured_samples":' .. jsonValue(injuredSamples) .. "}")
file:close()

print(string.format(
    "[InjuryFieldsProbe] Done. injury-named tables=%d, teamplayerlinks fields=%d, injured samples found=%d. Wrote %s",
    #injuryTableNames, #tplFieldNames, #injuredSamples, outPath
))
