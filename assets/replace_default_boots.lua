-- Description: Replace default shoes (0–15) with random ones for all players

require 'imports/career_mode/helpers'
require 'imports/other/helpers'

-- SETTINGS
local min_default = 0        -- start of default shoe range
local max_default = 15       -- end of default shoe range
local max_shoes = 200        -- total available shoe models (adjust if needed)

-- Get players table
local players_table = LE.db:GetTable("players")
local current_record = players_table:GetFirstRecord()

local count = 0
while current_record > 0 do
    local shoe_type = players_table:GetRecordFieldValue(current_record, "shoetypecode")

    -- Check for default shoes
    if shoe_type >= min_default and shoe_type <= max_default then
        -- Assign random shoe type (non-default)
        local new_shoe = math.random(max_default + 1, max_shoes)
        players_table:SetRecordFieldValue(current_record, "shoetypecode", new_shoe)
        count = count + 1
    end

    current_record = players_table:GetNextValidRecord()
end

MessageBox("Done", string.format("Changed shoes for %d players", count))
