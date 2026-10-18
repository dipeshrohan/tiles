# Backtest: Die cooling, moving half

- **Model:** `die-cooling` 1.0.0, window output `over_limit`, hourly windows
- **Inputs:** `{k}.die_temp_moving`, `{k}.die_temp_fixed`, `{k}.cooling_flow_moving` (joined within 5 min)
- **Events:** the MES's unplanned `DT-DIE` stops on DC-01, DC-02, DC-03, DC-04
- **Warning horizon:** 14.0 d before a stop
- **Setting:** window 120, k 1, persist 4, flat spread 0.01, chosen on October to March from 18
- **Target:** recall at least 70.0%, at most 0.05 false warnings a day per cell, a median warning time of at least 2.0 d
- **Windows:** 24,710
- **Result:** beats its target

| Period | Recall | Warnings | False per day | Warning time (median, min to max) | Meets target |
|---|--:|--:|--:|---|---|
| October to March (chosen on) | 100.0% (4/4) | 5 | 0.001 | 5.4 d (4.3 d to 6.3 d) | yes |
| April to September (held out) | 100.0% (2/2) | 2 | 0.001 | 7.6 d (6.1 d to 9.0 d) | yes |
| The year | 100.0% (6/6) | 7 | 0.001 | 5.9 d (4.3 d to 9.0 d) | yes |

## Stops in the year

| Cell | Stop | Warned | Warning time |
|---|---|---|--:|
| DC-01 | 2025-10-28T19:30+01:00 | yes | 6.3 d |
| DC-01 | 2025-12-08T01:00+01:00 | yes | 5.0 d |
| DC-01 | 2026-04-08T20:57+02:00 | yes | 9.0 d |
| DC-03 | 2026-03-14T11:51+01:00 | yes | 4.3 d |
| DC-03 | 2026-03-15T22:00+01:00 | yes | 5.7 d |
| DC-03 | 2026-05-29T14:44+02:00 | yes | 6.1 d |
