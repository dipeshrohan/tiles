# Baseline metrics

Made by `tiles-sample-plant generate biologics` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), the batches and the vials.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |
| --- | --- | --- | --- | --- |
| WB-01 | 2 | 0.2 | 2 | 282 |
| WB-02 | 1 | 0.1 | 0 | 47 |
| SB-01 | 7 | 0.6 | 6 | 2,221 |
| SB-02 | 7 | 0.6 | 9 | 3,640 |
| BR-01 | 6 | 0.5 | 6 | 14,784 |
| BR-02 | 8 | 0.7 | 36 | 89,874 |
| BR-03 | 4 | 0.3 | 5 | 11,980 |
| BR-04 | 4 | 0.3 | 36 | 89,268 |
| MP-01 | 5 | 0.4 | 18 | 5,400 |
| CIP-01 | 4 | 0.3 | 19 | 11,611 |
| CF-01 | 10 | 0.8 | 50 | 60,470 |
| DF-01 | 2 | 0.2 | 1 | 226 |
| BP-01 | 9 | 0.8 | 21 | 6,344 |
| CS-01 | 7 | 0.6 | 3 | 5,065 |
| VT-01 | 4 | 0.3 | 1 | 248 |
| CS-02 | 22 | 1.8 | 122 | 146,125 |
| VF-01 | 3 | 0.2 | 1 | 427 |
| UF-01 | 7 | 0.6 | 16 | 14,600 |
| BF-01 | 0 | 0.0 | 0 | 0 |
| CIP-02 | 3 | 0.2 | 21 | 8,362 |
| FL-01 | 25 | 2.1 | 12 | 20,990 |
| LY-01 | 4 | 0.3 | 20 | 64,414 |
| CP-01 | 11 | 0.9 | 19 | 11,678 |
| AVI-01 | 15 | 1.2 | 3 | 2,317 |
| WFI-01 | 2 | 0.2 | 21 | 30,973 |

## Batches

79 batches inoculated; 2 lost (B26066: batch lost: agitator seal failed, sterile boundary breached, B26077: batch lost: agitator seal failed, sterile boundary breached), 1,700,000 EUR. 71 drug substance lots tested (402.2 kg), 3 rejected (DS26042, DS26065, DS26070).

## Vials

67 fill lots, 374,525 vials filled, 3,635 rejected.

| Code | Reject | Vials | Of those filled | Cost (EUR) |
| --- | --- | --- | --- | --- |
| VIS-COS | Vial rejected at inspection: cosmetic defect | 1,139 | 0.30 % | 159,460 |
| FIL-WT | Vial rejected by the checkweigher: fill weight | 854 | 0.23 % | 119,560 |
| VIS-PART | Vial rejected at inspection: particles | 834 | 0.22 % | 116,760 |
| VIS-CAKE | Vial rejected at inspection: collapsed cake | 515 | 0.14 % | 72,100 |
| VIS-CRIMP | Vial rejected at inspection: crimp defect | 293 | 0.08 % | 41,020 |
