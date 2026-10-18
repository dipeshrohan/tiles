# Backtest: Holding furnace heater

- **Model:** `furnace-heater` 1.0.0, window output `heater_excess`, hourly windows
- **Inputs:** `hf{n}.heater_power`, `hf{n}.bath_temp`, `{k}.cycle_time` (joined within 5 min)
- **Events:** the MES's unplanned `DT-FUR` stops on DC-01, DC-02, DC-03, DC-04
- **Warning horizon:** 14.0 d before a stop
- **Setting:** window 240, k 3, persist 2, chosen on October to March from 36
- **Target:** recall at least 70.0%, at most 0.05 false warnings a day per cell, a median warning time of at least 2.0 d
- **Windows:** 24,703
- **Result:** beats its target

| Period | Recall | Warnings | False per day | Warning time (median, min to max) | Meets target |
|---|--:|--:|--:|---|---|
| October to March (chosen on) | 100.0% (3/3) | 14 | 0.000 | 9.1 d (5.6 d to 10.5 d) | yes |
| April to September (held out) | 100.0% (1/1) | 2 | 0.000 | 5.9 d (5.9 d to 5.9 d) | yes |
| The year | 100.0% (4/4) | 16 | 0.000 | 7.5 d (5.6 d to 10.5 d) | yes |

## Stops in the year

| Cell | Stop | Warned | Warning time |
|---|---|---|--:|
| DC-01 | 2026-03-09T12:49+01:00 | yes | 5.6 d |
| DC-02 | 2026-04-24T00:18+02:00 | yes | 5.9 d |
| DC-03 | 2026-03-04T18:45+01:00 | yes | 9.1 d |
| DC-04 | 2026-01-17T00:36+01:00 | yes | 10.5 d |
