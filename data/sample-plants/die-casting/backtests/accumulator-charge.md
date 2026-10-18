# Backtest: Shot accumulator charge

- **Model:** `accumulator-charge` 1.0.0, window output `sag`, hourly windows
- **Inputs:** `{k}.pressure_buildup_time`, `{k}.accumulator_pressure` (joined within 5 min)
- **Events:** the MES's unplanned `DT-HYD` stops (and `HYD`, its older name) on DC-01, DC-02, DC-03, DC-04
- **Warning horizon:** 14.0 d before a stop
- **Setting:** window 120, k 3, persist 3, chosen on October to March from 36
- **Target:** recall at least 70.0%, at most 0.05 false warnings a day per cell, a median warning time of at least 12.0 h
- **Windows:** 24,710
- **Result:** beats its target

| Period | Recall | Warnings | False per day | Warning time (median, min to max) | Meets target |
|---|--:|--:|--:|---|---|
| October to March (chosen on) | 75.0% (3/4) | 4 | 0.001 | 30.0 h (25.6 h to 4.3 d) | yes |
| April to September (held out) | 100.0% (7/7) | 6 | 0.000 | 2.2 d (37.8 h to 4.2 d) | yes |
| The year | 90.9% (10/11) | 10 | 0.001 | 2.1 d (25.6 h to 4.3 d) | yes |

## Stops in the year

| Cell | Stop | Warned | Warning time |
|---|---|---|--:|
| DC-01 | 2026-04-24T15:56+02:00 | yes | 42.0 h |
| DC-01 | 2026-05-30T11:54+02:00 | yes | 2.0 d |
| DC-01 | 2026-05-31T22:00+02:00 | yes | 3.5 d |
| DC-01 | 2026-07-01T05:59+02:00 | yes | 2.2 d |
| DC-01 | 2026-09-01T21:53+02:00 | yes | 4.2 d |
| DC-02 | 2025-10-30T21:00+01:00 | yes | 30.0 h |
| DC-03 | 2025-10-15T05:07+02:00 | yes | 4.3 d |
| DC-04 | 2026-01-05T15:45+01:00 | **no** | - |
| DC-04 | 2026-01-15T03:35+01:00 | yes | 25.6 h |
| DC-04 | 2026-05-13T08:46+02:00 | yes | 37.8 h |
| DC-04 | 2026-07-21T20:58+02:00 | yes | 3.9 d |
