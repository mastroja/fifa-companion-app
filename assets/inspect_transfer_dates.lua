-- ============================================================
-- RESOLVED 2026-08-31 — kept only as a record of how the negotiation
-- date bug was found. The fix (convertNegotiationDate, plus the loan/
-- exchange off-by-one) is live in export_all.lua and export_transfers.lua.
-- No need to run this again unless a future date-related bug needs the
-- same kind of raw-struct investigation.
-- ============================================================

MEMORY = require 'imports/core/memory'
require 'imports/other/helpers'
require 'imports/career_mode/enums'
require 'imports/career_mode/helpers'

-- ============================================================
-- READ-ONLY DIAGNOSTIC v2 — run manually from Live Editor's Lua Engine.
-- Do NOT bind to F10, do NOT fold into export_all.lua.
--
-- v1 (a blind scan for any int in a "plausible date" numeric range) found
-- nothing real — every hit was either player_id re-detected by coincidence
-- (at offset 0x0) or a suspiciously round, wildly-scattered number (steps
-- of exactly 5000, spanning the years 2007-2130 for deals that should all
-- be from the SAME current season). Neither is a real per-deal date.
--
-- This version instead prints the RAW, UNFILTERED value at the EXACT
-- offsets production already reads (see get_transfer_data in
-- export_all.lua/export_transfers.lua), plus surrounding context, so we
-- can see what's actually there instead of guessing:
--   - for the index-based vectors (ai_player_transfer/exchange/loan):
--     the raw last_action_idx byte (signed and unsigned reading) and the
--     computed address it produces
--   - for the pointer-based vectors (user_player_transfer/exchange): the
--     mActionsBegin/mActionsEnd pointers, how many action entries that
--     implies, and a raw dump of every int in the last TWO action entries
--     (the struct's last_action byte at +0x8 is already confirmed correct
--     via is_user filtering, so this checks what's really at +0x0/+0x4)
--   - GetCurrentDate() as ground truth, plus what raw day-offset that
--     maps to under the SAME epoch convertFifaDate uses elsewhere (so we
--     have a real number to compare candidates against instead of a wide
--     guessed range)
--
-- Output: C:\Users\Public\ea_fc_date_probe_v2.json
-- ============================================================

local outPath = "C:\\Users\\Public\\ea_fc_date_probe_v2.json"
local MAX_NEGOTIATION_ENTRIES = 200 -- v2 only needs a handful of samples per vector

local function walk_negotiation_vector(storage, vec_offset, obj_size, visit)
    if not storage or storage == 0 then return end
    local vec = MEMORY:ReadPointer(storage + vec_offset)
    if not vec or vec == 0 then return end
    local mBegin = MEMORY:ReadPointer(vec + 0x0)
    local mEnd = MEMORY:ReadPointer(vec + 0x8)
    if not mBegin or not mEnd or mBegin == 0 or mEnd == 0 or mEnd < mBegin then return end
    local current = mBegin
    local iterations = 0
    while current < mEnd and iterations < MAX_NEGOTIATION_ENTRIES do
        visit(current, iterations)
        current = current + obj_size
        iterations = iterations + 1
    end
end

local file = io.open(outPath, "w")
if not file then
    print("[DateProbeV2] FAILED to open output file: " .. outPath)
    return
end

local entries = {}
local function add(obj) table.insert(entries, obj) end

assert(IsInCM(), "Script must be executed in career mode")

-- Ground truth: current in-game date, both as day/month/year and as the
-- raw day-offset the SAME epoch formula (base 1582-10-14, the one
-- convertFifaDate uses for dob/jointeamdate/loan-end elsewhere in this
-- app) would produce, so candidate values below can be compared against
-- a real number instead of a guessed range.
local cd = GetCurrentDate()
local function toJulianDayOffset(day, month, year)
    -- Inverse of convertFifaDate's targetSeconds formula: seconds since
    -- 1582-10-14 UTC, divided into days. Uses os.time on a UTC-ish local
    -- calc; good enough for a same-machine sanity comparison.
    local ok, t = pcall(os.time, { year = year, month = month, day = day, hour = 12 })
    if not ok or not t then return nil end
    local baseEpochSeconds = -12219292800
    return math.floor((t - baseEpochSeconds) / 86400)
end
local currentDayOffset = cd and toJulianDayOffset(cd.day, cd.month, cd.year) or nil
add({
    kind = "ground_truth",
    current_date = cd and string.format("%02d/%02d/%04d", cd.day, cd.month, cd.year) or "unknown",
    current_day_offset = currentDayOffset
})

local ok, transfer_mgr = pcall(GetManagerObjByTypeId, ENUM_FCEGameModesFCECareerModeTransferManager)
if not ok or not transfer_mgr or transfer_mgr == 0 then
    print("[DateProbeV2] Transfer Manager object not found.")
    file:write("[]")
    file:close()
    return
end

local neg_storage = MEMORY:ReadPointer(transfer_mgr + 0x1DD0)

-- ---- Index-based vectors (ai_player_transfer/exchange/loan) ----
local function readSignedByte(addr)
    local v = MEMORY:ReadChar(addr)
    if v and v >= 128 then return v - 256 end
    return v
end

local INDEX_VECTORS = {
    { name = "ai_player_transfer", vec_offset = 0x10, obj_size = 0xB0, accepted_off = 0x67, idx_off = 0x6C, array_base = 0x70, idx_minus_one = false },
    { name = "ai_player_exchange", vec_offset = 0x40, obj_size = 0xA8, accepted_off = 0x67, idx_off = 0x6B, array_base = 0x6C, idx_minus_one = true },
    { name = "ai_player_loan",     vec_offset = 0x20, obj_size = 0x98, accepted_off = 0x52, idx_off = 0x57, array_base = 0x58, idx_minus_one = true },
}

for _, v in ipairs(INDEX_VECTORS) do
    local count = 0
    walk_negotiation_vector(neg_storage, v.vec_offset, v.obj_size, function(current, i)
        if count >= 5 then return end -- only need a few samples per vector
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if playerid > 0 and buying_team > 0 and selling_team > 0 then
            local accepted = MEMORY:ReadBool(current + v.accepted_off)
            if accepted then
                count = count + 1
                local idxUnsigned = MEMORY:ReadChar(current + v.idx_off)
                local idxSigned = readSignedByte(current + v.idx_off)
                local usedIdx = v.idx_minus_one and (idxUnsigned - 1) or idxUnsigned
                local computedAddr = current + v.array_base + (0xC * usedIdx)
                local ok2, rawAtComputed = pcall(function() return MEMORY:ReadInt(computedAddr) end)
                -- Also dump every int from array_base to array_base+0x40 raw,
                -- unfiltered, indexed by slot number, so we can see the whole
                -- actions array regardless of whether idx/base is right.
                local rawDump = {}
                for slot = 0, 5 do
                    local addr = current + v.array_base + (0xC * slot)
                    local ok3, val = pcall(function() return MEMORY:ReadInt(addr) end)
                    local ok4, val2 = pcall(function() return MEMORY:ReadInt(addr + 4) end)
                    local ok5, val3 = pcall(function() return MEMORY:ReadChar(addr + 8) end)
                    table.insert(rawDump, {
                        slot = slot,
                        int_at_0 = ok3 and val or nil,
                        int_at_4 = ok4 and val2 or nil,
                        char_at_8 = ok5 and val3 or nil
                    })
                end
                add({
                    kind = "index_vector",
                    type = v.name,
                    player_id = playerid,
                    buying_team = buying_team,
                    selling_team = selling_team,
                    idx_unsigned = idxUnsigned,
                    idx_signed = idxSigned,
                    used_idx = usedIdx,
                    raw_at_computed_offset = ok2 and rawAtComputed or "READ_FAILED",
                    raw_dump = rawDump
                })
            end
        end
    end)
end

-- ---- Pointer-based vectors (user_player_transfer/exchange) ----
local POINTER_VECTORS = {
    { name = "user_player_transfer", vec_offset = 0x38, obj_size = 0x98, actions_begin_off = 0x50, actions_end_off = 0x58 },
    { name = "user_player_exchange", vec_offset = 0x48, obj_size = 0x98, actions_begin_off = 0x50, actions_end_off = 0x58 },
}

for _, v in ipairs(POINTER_VECTORS) do
    local count = 0
    walk_negotiation_vector(neg_storage, v.vec_offset, v.obj_size, function(current, i)
        if count >= 5 then return end
        local playerid = MEMORY:ReadInt(current + 0x0)
        local buying_team = MEMORY:ReadInt(current + 0x4)
        local selling_team = MEMORY:ReadInt(current + 0x8)
        if playerid > 0 and buying_team > 0 and selling_team > 0 then
            local mActionsBegin = MEMORY:ReadPointer(current + v.actions_begin_off)
            local mActionsEnd = MEMORY:ReadPointer(current + v.actions_end_off)
            if mActionsBegin and mActionsEnd and mActionsBegin ~= mActionsEnd then
                local lastAction = MEMORY:ReadChar(mActionsEnd - 0xC + 0x8)
                if lastAction == 0 or lastAction == 4 then
                    count = count + 1
                    local numActions = math.floor((mActionsEnd - mActionsBegin) / 0xC)
                    -- Dump the last 3 action entries (12 bytes each: two
                    -- ints + a byte) raw and unfiltered.
                    local rawDump = {}
                    for back = 0, 2 do
                        local addr = mActionsEnd - 0xC - (0xC * back)
                        if addr >= mActionsBegin then
                            local ok3, val = pcall(function() return MEMORY:ReadInt(addr) end)
                            local ok4, val2 = pcall(function() return MEMORY:ReadInt(addr + 4) end)
                            local ok5, val3 = pcall(function() return MEMORY:ReadChar(addr + 8) end)
                            table.insert(rawDump, {
                                entries_from_end = back,
                                int_at_0 = ok3 and val or nil,
                                int_at_4 = ok4 and val2 or nil,
                                char_at_8 = ok5 and val3 or nil
                            })
                        end
                    end
                    add({
                        kind = "pointer_vector",
                        type = v.name,
                        player_id = playerid,
                        buying_team = buying_team,
                        selling_team = selling_team,
                        num_actions = numActions,
                        raw_dump = rawDump
                    })
                end
            end
        end
    end)
end

-- Manual, dependency-free JSON serialization (Lua has no built-in json lib
-- here) — good enough for this diagnostic's flat/shallow structures.
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
        -- array vs object: if it has a "kind"/"slot"/"entries_from_end" etc,
        -- treat as object; if 1..n sequential, treat as array.
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

file:write(jsonValue(entries))
file:close()
print(string.format("[DateProbeV2] Done. Wrote %d entries to %s", #entries, outPath))
