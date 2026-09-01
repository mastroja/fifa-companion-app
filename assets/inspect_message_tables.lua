-- ============================================================
-- READ-ONLY DIAGNOSTIC — run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT bind to F10.
--
-- Goal: find out whether in-game career-mode notifications/emails/news
-- items (e.g. "Player X is injured", "You received a job offer") are
-- stored anywhere in the Lua-accessible DB, the same way inspect_injury_
-- fields.lua checked for a dedicated injury table.
--
-- This ONLY calls GetDBTablesNames() (pure name list, no iteration of
-- any table's rows) and then GetDBTableFields() (schema only, no row
-- reads) on any table whose name looks message/news/event related.
-- Nothing here iterates row data, so this carries no crash risk.
--
-- Output: C:\Users\Public\ea_fc_message_tables_probe.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_message_tables_probe.json"

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
    print("[MessageTablesProbe] FAILED to open output file: " .. outPath)
    return
end

local KEYWORDS = { "news", "message", "notif", "inbox", "alert", "mail", "email", "event" }

local ok1, allTableNames = pcall(GetDBTablesNames)
local allNames = {}
local matchedNames = {}
if ok1 and allTableNames then
    for _, name in ipairs(allTableNames) do
        table.insert(allNames, name)
        if type(name) == "string" then
            local lower = name:lower()
            for _, kw in ipairs(KEYWORDS) do
                if lower:find(kw) then
                    table.insert(matchedNames, name)
                    break
                end
            end
        end
    end
end

local matchedFields = {}
for _, name in ipairs(matchedNames) do
    local ok2, fields = pcall(GetDBTableFields, name)
    local fieldNames = {}
    if ok2 and fields then
        for _, f in ipairs(fields) do
            table.insert(fieldNames, f.name)
        end
    end
    matchedFields[name] = fieldNames
end

file:write(string.format(
    '{"total_table_count":%d,"matched_table_names":%s,"matched_table_fields":%s,"all_table_names":%s}',
    #allNames, jsonValue(matchedNames), jsonValue(matchedFields), jsonValue(allNames)
))
file:close()

print(string.format(
    "[MessageTablesProbe] Done. %d total tables, %d matched news/message/event keywords. Wrote %s",
    #allNames, #matchedNames, outPath
))
