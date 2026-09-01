-- ============================================================
-- READ-ONLY DIAGNOSTIC — run manually from Live Editor's Lua Engine
-- (Features -> Lua Engine -> paste -> execute). Do NOT bind to F10,
-- do NOT fold into export_all.lua until confirmed safe AND useful.
--
-- "persistent_events" is a table we have NEVER touched before (unlike
-- teamplayerlinks/playerloans/career_playercontract, which are already
-- safely iterated in production every export). Per project history,
-- the "transfers" table crashed the game the very first time
-- GetFirstRecord() was called on it -- schema introspection alone did
-- NOT predict that. So this script is deliberately staged:
--
--   STAGE 1: call GetTable + GetFirstRecord ONCE. Checkpoint (flush to
--            disk) immediately before AND after, so if the game dies
--            here we know record-iteration itself is unsafe for this
--            table, same as it was for transfers.
--   STAGE 2: only if Stage 1 survived -- read each of the 8 known
--            fields (eventid, id, eventdate, compobjid, team1id,
--            team2id, player1id, miscvalue) ONE AT A TIME off that
--            single first record, flushing after each, so a crash
--            points at the exact field that caused it.
--   STAGE 3: only if Stage 2 survived -- iterate up to a small capped
--            number of additional records (50, not 5000 -- we only
--            need enough samples to see real eventid/miscvalue
--            patterns, not a full dump) to gather sample data,
--            flushing every 10 records.
--
-- Do the same 3 stages for "scenarioevents" only if persistent_events
-- fully completes -- it's a lower-priority lead (looks like in-match
-- goal/card events, not career news), no need to risk it first.
--
-- Output: C:\Users\Public\ea_fc_persistent_events_probe.json
-- Progress is also flushed as human-readable lines at the TOP of the
-- file so partial progress survives a crash even if the JSON never
-- gets closed out properly.
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_persistent_events_probe.json"

local file = io.open(outPath, "w")
if not file then
    print("[PersistentEventsProbe] FAILED to open output file: " .. outPath)
    return
end

local function checkpoint(msg)
    print("[PersistentEventsProbe] " .. msg)
    file:write("// CHECKPOINT: " .. msg .. "\n")
    file:flush()
end

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
        local isArray, n = true, 0
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

local function probeTable(tableName, fieldNames, maxExtraSamples)
    checkpoint(tableName .. ": about to call LE.db:GetTable()")
    local ok0, tbl = pcall(function() return LE.db:GetTable(tableName) end)
    if not ok0 or not tbl then
        checkpoint(tableName .. ": GetTable FAILED or returned nil")
        return nil
    end
    checkpoint(tableName .. ": GetTable succeeded")

    -- STAGE 1
    checkpoint(tableName .. ": about to call GetFirstRecord() [STAGE 1 - highest risk point]")
    local ok1, rec = pcall(function() return tbl:GetFirstRecord() end)
    checkpoint(tableName .. ": GetFirstRecord() returned (ok=" .. tostring(ok1) .. ")")
    if not ok1 or not rec or rec <= 0 then
        checkpoint(tableName .. ": no records or call failed, stopping")
        return { table_name = tableName, first_record_ok = ok1, samples = {} }
    end

    -- STAGE 2: read each field individually off the first record
    checkpoint(tableName .. ": STAGE 2 - reading fields one at a time from first record")
    local firstSample = {}
    for _, fname in ipairs(fieldNames) do
        local okf, val = pcall(function() return tbl:GetRecordFieldValue(rec, fname) end)
        firstSample[fname] = okf and val or "READ_FAILED"
        checkpoint(tableName .. ": field '" .. fname .. "' = " .. tostring(firstSample[fname]))
    end

    local samples = { firstSample }

    -- STAGE 3: capped additional iteration
    checkpoint(tableName .. ": STAGE 3 - iterating up to " .. maxExtraSamples .. " more records")
    local count = 0
    local ok2, nextRec = pcall(function() return tbl:GetNextValidRecord() end)
    while ok2 and nextRec and nextRec > 0 and count < maxExtraSamples do
        local sample = {}
        for _, fname in ipairs(fieldNames) do
            local okf, val = pcall(function() return tbl:GetRecordFieldValue(nextRec, fname) end)
            sample[fname] = okf and val or "READ_FAILED"
        end
        table.insert(samples, sample)
        count = count + 1
        if count % 10 == 0 then
            checkpoint(tableName .. ": iterated " .. count .. " extra records so far")
        end
        ok2, nextRec = pcall(function() return tbl:GetNextValidRecord() end)
    end
    checkpoint(tableName .. ": done, total samples=" .. #samples)

    return { table_name = tableName, first_record_ok = true, samples = samples }
end

local PERSISTENT_EVENTS_FIELDS = { "eventid", "id", "eventdate", "compobjid", "team1id", "team2id", "player1id", "miscvalue" }
local results = {}

results.persistent_events = probeTable("persistent_events", PERSISTENT_EVENTS_FIELDS, 50)

checkpoint("ALL STAGES COMPLETE for persistent_events -- writing final JSON")
file:write("\n" .. jsonValue(results))
file:close()

print("[PersistentEventsProbe] Fully done. Wrote " .. outPath)
