# News feed images

One folder per news type, named exactly as below (matching the keys in
`NEWS_TYPE_META` in `index.html`). Drop as many images as you want into
a type's folder — the News tab picks one at random each time a story of
that type is shown, so repeated events don't all show the same picture.
Add more any time; nothing else needs to change. A type with no folder
(or an empty one) just falls back to a plain emoji badge.

| Folder | News type | Status |
| --- | --- | --- |
| `hat_trick/` | Hat-trick | ✅ populated |
| `brace/` | Brace (2 goals) | ✅ populated |
| `motm/` | Man of the Match | ✅ populated |
| `player_of_month/` | Player of the Month | ✅ populated |
| `injury/` | New injury | ✅ populated |
| `injury_recovery/` | Back from injury | ✅ populated |
| `competition_win/` | Won a competition | ✅ populated |
| `race_lead_change/` | Golden Boot / Playmaker / Golden Glove / POTY race lead change | ✅ populated |
| `transfer/` | Notable transfer | ✅ populated |
| `win_streak/` | Win streak | ✅ populated |
| `unbeaten_streak/` | Unbeaten streak | needed |
| `milestone/` | Season stat milestone | needed |
| `contract_signed/` | Contract renewal | needed |
| `new_captain/` | New club captain | ✅ populated |
| `youth_promotion/` | Youth academy promotion | ✅ populated |
| `red_card/` | Player sent off | needed (folder exists, empty) |
| `yellow_card_milestone/` | Every 5th yellow card of the season (suspension risk) | ✅ populated |
| `notable_goal/` | Generic single-goal highlight — only used to round an edition out to 3 stories when there isn't enough real news that matchweek | ✅ populated |
| `rivalry_battle/` | Generic "intense battle" filler for a close match (decided by a goal or less) | ✅ populated |
| `post_match_reaction/` | Generic post-match player reaction/quote filler | ✅ populated |

`notable_goal`/`rivalry_battle`/`post_match_reaction` are the three "generic" types — real match/scorer/scoreline, but not tied to a specific detected achievement. They're ranked lowest in `NEWS_TYPE_PRIORITY` (main.js) so they only ever fill in when the week's real news doesn't already fill all 3 story slots.
