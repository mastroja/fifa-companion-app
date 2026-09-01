-- ============================================================
-- READ-ONLY(ish) DIAGNOSTIC — run manually from Live Editor's Lua
-- Engine (Features -> Lua Engine -> paste -> execute). Do NOT bind to
-- F10. User has explicitly accepted crash risk for this investigation.
--
-- Goal: find where the game's actual in-game news/notification feed
-- (the popups with real text: "Player X injured", job offers, etc.)
-- lives in memory. Raw memory reverse engineering -- same risk
-- category as the past transfer-date investigation, which DID
-- eventually succeed this way.
--
-- v2: probes BOTH candidate managers in one run:
--   - ENUM_FCEGameModesFCECareerModeNewsManager: v1 of this script
--     found this resolves to 0 ("no instance") when the in-game
--     news/inbox screen isn't currently open -- many FCE manager
--     objects are lazily created only while their UI is active, unlike
--     DB tables which always exist. TIP: have the in-game career mode
--     news/notifications screen open when you run this.
--   - ENUM_FCEGameModesFCECareerModePersistentEventsManager: the
--     manager tied to the "persistent_events" DB table we already
--     confirmed is always populated and safe to read -- more likely
--     to be persistently alive regardless of what screen is open.
--
-- Strategy per manager (staged, checkpointed so a crash still tells us
-- where):
--   STAGE 1: resolve the manager object address. Read-only, low risk.
--   STAGE 2: dump raw qword/int values at offsets 0x0-0x300 from the
--            manager's OWN memory (not following any pointers yet).
--   STAGE 3: from that dump, look for a begin/end POINTER PAIR (the
--            standard FCE vector convention confirmed in SetSquadRole
--            in helpers.lua) -- purely arithmetic, zero extra risk.
--   STAGE 4: HIGHEST RISK STEP. Dereference at most 2 of the most
--            plausible candidate vector-begin pointers, one 4-byte int
--            at a time, each checkpointed individually.
--   STAGE 5: auto-decode any int in the CM event-message range (0-200)
--            via GetCMEventNameByID, and flag any int matching a known
--            player ID from the user's own senior squad.
--
-- Output: C:\Users\Public\ea_fc_news_manager_probe.json
-- ============================================================

MEMORY = require 'imports/core/memory'
require 'imports/other/helpers'
require 'imports/career_mode/enums'
require 'imports/career_mode/consts'
require 'imports/career_mode/helpers'

local outPath = "C:\\Users\\Public\\ea_fc_news_manager_probe.json"

-- Truncate/create the file fresh at start.
local initFile = io.open(outPath, "w")
if not initFile then
    print("[NewsManagerProbe] FAILED to open output file: " .. outPath)
    return
end
initFile:close()

-- Each checkpoint opens-appends-closes immediately rather than holding
-- one file handle open for the whole run, so a stale/closed handle
-- (whatever caused "attempt to use a closed file" last run) can't
-- break subsequent writes -- every checkpoint is fully independent.
local function checkpoint(msg)
    print("[NewsManagerProbe] " .. msg)
    local f = io.open(outPath, "a")
    if f then
        f:write("// CHECKPOINT: " .. msg .. "\n")
        f:close()
    end
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

assert(IsInCM(), "Script must be executed in career mode")

-- Ground truth: user's own senior squad player IDs -- news popups are
-- almost certainly scoped to the user's team, unlike persistent_events
-- which logs every CPU team's background sim too.
local userPlayerIds = {}
local ok0, idSet = pcall(GetUserSeniorTeamPlayerIDs)
if ok0 and idSet then
    for pid, _ in pairs(idSet) do table.insert(userPlayerIds, pid) end
end
checkpoint("Ground truth: " .. #userPlayerIds .. " user senior-squad player IDs collected")
local userPlayerIdSet = {}
for _, pid in ipairs(userPlayerIds) do userPlayerIdSet[pid] = true end

local STRUCT_SIZE_CANDIDATES = { 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 96, 128 }
-- Widened from 0x300: TransferManager's real vector lives behind a
-- single-indirection pointer at offset 0x1DD0 (confirmed working in
-- export_all.lua/export_transfers.lua) -- 0x300 was nowhere near far
-- enough in. 0x2000 comfortably covers that known precedent.
local HEADER_END = 0x2000
local MAX_VECTOR_CANDIDATES_TO_TRY = 2
local MAX_LONE_POINTER_CANDIDATES_TO_TRY = 5
local READ_INTS = 24 -- 24 x 4 bytes = enough for a couple of small entries
local SUBOBJECT_DUMP_END = 0x400 -- range to dump when following a lone-pointer indirection

local function dumpQwordRange(label, baseAddr, rangeEnd)
    local qwords = {}
    for off = 0, rangeEnd, 0x8 do
        local okq, qv = pcall(function() return MEMORY:ReadQword(baseAddr + off) end)
        qwords[off] = okq and qv or nil
        if off % 0x400 == 0 then
            checkpoint(string.format("%s   ...scanned through offset 0x%X", label, off))
        end
    end
    return qwords
end

local function findVectorPairCandidates(qwords, rangeEnd)
    local candidates = {}
    for off = 0, rangeEnd - 0x8, 0x8 do
        local a, b = qwords[off], qwords[off + 0x8]
        if a and b and a > 0x10000 and b > a and (b - a) >= 8 and (b - a) <= 2000000 then
            local diff = b - a
            local matchingSizes = {}
            for _, sz in ipairs(STRUCT_SIZE_CANDIDATES) do
                if diff % sz == 0 then
                    local count = diff // sz
                    if count >= 1 and count <= 3000 then
                        table.insert(matchingSizes, { struct_size = sz, entry_count = count })
                    end
                end
            end
            if #matchingSizes > 0 then
                table.insert(candidates, {
                    begin_offset = off, begin_ptr = a, end_ptr = b,
                    byte_diff = diff, plausible_struct_sizes = matchingSizes
                })
            end
        end
    end
    table.sort(candidates, function(x, y)
        local function score(c)
            local best = 999999
            for _, m in ipairs(c.plausible_struct_sizes) do
                if m.entry_count >= 1 and m.entry_count <= 500 then
                    best = math.min(best, m.struct_size)
                end
            end
            return best
        end
        return score(x) < score(y)
    end)
    return candidates
end

-- A "lone pointer" is a single qword that looks like a plausible heap/
-- process address but isn't part of an ascending begin/end pair --
-- this is the TransferManager-style single-indirection-to-a-storage-
-- substruct pattern (mgr + 0x1DD0 = a single pointer, not a vector).
--
-- CRASH LESSON (this script, run 3): 0x1E00000010 passed the old filter
-- (>0x10000, <0x00007FFFFFFFFFFF, %8==0) but was garbage -- its low 32
-- bits (0x10 = 16) are suspiciously tiny, the classic signature of two
-- ordinary small ints sitting adjacent in memory misread as one 64-bit
-- pointer, not a real heap address. Dereferencing it killed the game
-- outright (a native access violation, not a catchable Lua error --
-- pcall did not save us here). Real pointers observed so far
-- (0x682B23C0, 0x6DDF5910, 0x68016BC0, 0x14B778B30) all have "messy"
-- low 32 bits typical of real heap addresses, so require that instead.
local function findLonePointerCandidates(qwords, rangeEnd, mgrAddr)
    local candidates = {}
    for off = 0, rangeEnd, 0x8 do
        local v = qwords[off]
        if v and v > 0x10000 and v < 0x00007FFFFFFFFFFF and v % 8 == 0 and v ~= mgrAddr then
            local low32 = v % 0x100000000
            if low32 >= 0x10000 then -- reject "small_int_hi<<32 | small_int_lo" false positives
                table.insert(candidates, { offset = off, ptr = v })
            end
        end
    end
    return candidates
end

local function decodeIntDump(entryDump, readInts)
    local decodedHits = {}
    for j = 0, readInts - 1 do
        local v = entryDump[j + 1]
        if type(v) == "number" then
            if v >= 0 and v <= 200 then
                local name = GetCMEventNameByID(v)
                if name and not name:match("^EVENT_%d+$") then
                    table.insert(decodedHits, { int_index = j, value = v, decoded_event_name = name })
                end
            end
            if userPlayerIdSet[v] then
                table.insert(decodedHits, { int_index = j, value = v, matched_user_player_id = true })
            end
            if v >= 20250101 and v <= 20271231 then
                table.insert(decodedHits, { int_index = j, value = v, looks_like_yyyymmdd_date = true })
            end
        end
    end
    return decodedHits
end

-- Writes one completed finding straight to disk, independent of the
-- final summary JSON -- so if a LATER step crashes the game, everything
-- already found before it survives. (Lesson from run 3: the final JSON
-- is only written once at the very end, so a crash mid-run loses every
-- already-computed result unless it's also saved incrementally here.)
local function writeResultNow(tag, obj)
    local f = io.open(outPath, "a")
    if f then
        f:write("// RESULT " .. tag .. ": " .. jsonValue(obj) .. "\n")
        f:close()
    end
end

local function dereferenceAndDecode(label, tag, ptr)
    checkpoint(string.format("%s: about to dereference %s at 0x%X [HIGH RISK]", label, tag, ptr))
    local entryDump = {}
    local allOk = true
    for j = 0, READ_INTS - 1 do
        local addr = ptr + (j * 4)
        local okr, val = pcall(function() return MEMORY:ReadInt(addr) end)
        entryDump[j + 1] = okr and val or "READ_FAILED"
        if not okr then allOk = false end
    end
    checkpoint(string.format("%s: %s dereference complete (all_ok=%s)", label, tag, tostring(allOk)))
    local decodedHits = decodeIntDump(entryDump, READ_INTS)
    writeResultNow(label .. " " .. tag, { ptr = string.format("0x%X", ptr), raw_int_dump = entryDump, decoded_hits = decodedHits })
    return entryDump, decodedHits
end

local function probeManager(label, type_id)
    checkpoint(label .. " STAGE 1: resolving via GetManagerObjByTypeId")
    local ok1, mgr = pcall(GetManagerObjByTypeId, type_id)
    if not ok1 or not mgr or mgr == 0 then
        checkpoint(label .. " STAGE 1 FAILED: not found (ok=" .. tostring(ok1) .. ", addr=" .. tostring(mgr) .. ")")
        return { label = label, error = "manager_not_found" }
    end
    checkpoint(string.format("%s STAGE 1 OK: mgr = 0x%X", label, mgr))

    checkpoint(string.format("%s STAGE 2: dumping raw qword values at offsets 0x0-0x%X", label, HEADER_END))
    local qwords = dumpQwordRange(label, mgr, HEADER_END)
    checkpoint(label .. " STAGE 2 OK: header dump complete")

    checkpoint(label .. " STAGE 3: scanning for vector-like begin/end pointer pairs")
    local vectorCandidates = findVectorPairCandidates(qwords, HEADER_END)
    checkpoint(label .. " STAGE 3 OK: found " .. #vectorCandidates .. " candidate vector pairs directly on manager")
    writeResultNow(label .. " direct_vector_candidates (pre-dereference)", vectorCandidates)

    local dereferenced = {}
    for i = 1, math.min(MAX_VECTOR_CANDIDATES_TO_TRY, #vectorCandidates) do
        local c = vectorCandidates[i]
        local entryDump, decodedHits = dereferenceAndDecode(label, string.format("direct vector candidate #%d (header offset 0x%X)", i, c.begin_offset), c.begin_ptr)
        table.insert(dereferenced, {
            kind = "direct_vector", candidate_index = i, begin_offset = c.begin_offset,
            begin_ptr = string.format("0x%X", c.begin_ptr),
            plausible_struct_sizes = c.plausible_struct_sizes,
            raw_int_dump = entryDump, decoded_hits = decodedHits
        })
    end

    -- STAGE 5: no direct vector pair found on the manager itself (or we
    -- want to check anyway) -- follow single-indirection "lone pointer"
    -- candidates (the TransferManager mgr+0x1DD0 pattern) one level
    -- deep and look for a vector pair INSIDE that sub-object instead.
    checkpoint(label .. " STAGE 5: scanning for lone indirection pointers to follow one level deep")
    local lonePointers = findLonePointerCandidates(qwords, HEADER_END, mgr)
    checkpoint(label .. " STAGE 5: found " .. #lonePointers .. " lone pointer candidates")
    writeResultNow(label .. " lone_pointer_candidates (pre-dereference)", lonePointers)

    local subObjectFindings = {}
    for i = 1, math.min(MAX_LONE_POINTER_CANDIDATES_TO_TRY, #lonePointers) do
        local lp = lonePointers[i]
        checkpoint(string.format("%s STAGE 5: following lone pointer #%d at header offset 0x%X (ptr=0x%X) [HIGH RISK]", label, i, lp.offset, lp.ptr))
        local subQwords = dumpQwordRange(label .. " [sub#" .. i .. "]", lp.ptr, SUBOBJECT_DUMP_END)
        local subVectorCandidates = findVectorPairCandidates(subQwords, SUBOBJECT_DUMP_END)
        checkpoint(string.format("%s STAGE 5: lone pointer #%d sub-scan found %d nested vector candidates", label, i, #subVectorCandidates))
        writeResultNow(string.format("%s lone-ptr#%d nested_vector_candidates (pre-dereference)", label, i), subVectorCandidates)

        local subDereferenced = {}
        for j = 1, math.min(MAX_VECTOR_CANDIDATES_TO_TRY, #subVectorCandidates) do
            local c = subVectorCandidates[j]
            local entryDump, decodedHits = dereferenceAndDecode(
                label,
                string.format("lone-ptr#%d -> nested vector candidate #%d (sub-offset 0x%X)", i, j, c.begin_offset),
                c.begin_ptr
            )
            table.insert(subDereferenced, {
                candidate_index = j, sub_offset = c.begin_offset,
                begin_ptr = string.format("0x%X", c.begin_ptr),
                plausible_struct_sizes = c.plausible_struct_sizes,
                raw_int_dump = entryDump, decoded_hits = decodedHits
            })
        end

        table.insert(subObjectFindings, {
            lone_pointer_index = i, header_offset = lp.offset,
            sub_ptr = string.format("0x%X", lp.ptr),
            nested_vector_candidates_found = #subVectorCandidates,
            nested_dereferenced = subDereferenced
        })
    end
    checkpoint(label .. " STAGE 5 COMPLETE")

    return {
        label = label,
        mgr_addr = string.format("0x%X", mgr),
        direct_vector_candidates_found = #vectorCandidates,
        direct_vector_candidates = vectorCandidates,
        direct_dereferenced = dereferenced,
        lone_pointer_candidates_found = #lonePointers,
        sub_object_findings = subObjectFindings
    }
end

local results = {}
table.insert(results, probeManager("NewsManager", ENUM_FCEGameModesFCECareerModeNewsManager))
table.insert(results, probeManager("PersistentEventsManager", ENUM_FCEGameModesFCECareerModePersistentEventsManager))

local finalResult = {
    user_player_ids_sample = userPlayerIds,
    managers = results
}
local finalFile = io.open(outPath, "a")
if finalFile then
    finalFile:write("\n" .. jsonValue(finalResult))
    finalFile:close()
end

checkpoint("ALL MANAGERS COMPLETE -- wrote " .. outPath)
print("[NewsManagerProbe] Fully done.")
