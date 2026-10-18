# Baseline metrics

Made by `tiles-sample-plant generate biologics` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), the batches and the vials.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |
| --- | --- | --- | --- | --- |
| WB-01 | 2 | 0.2 | 2 | 282 |
| WB-02 | 2 | 0.2 | 1 | 215 |
| SB-01 | 7 | 0.6 | 6 | 2,221 |
| SB-02 | 7 | 0.6 | 9 | 3,640 |
| BR-01 | 6 | 0.5 | 6 | 14,784 |
| BR-02 | 7 | 0.6 | 7 | 17,050 |
| BR-03 | 4 | 0.3 | 5 | 11,980 |
| BR-04 | 4 | 0.3 | 36 | 89,268 |
| MP-01 | 5 | 0.4 | 22 | 6,566 |
| CIP-01 | 5 | 0.4 | 24 | 14,421 |
| CF-01 | 10 | 0.8 | 50 | 60,470 |
| DF-01 | 2 | 0.2 | 1 | 226 |
| BP-01 | 9 | 0.8 | 23 | 6,909 |
| CS-01 | 8 | 0.7 | 3 | 5,243 |
| VT-01 | 4 | 0.3 | 1 | 248 |
| CS-02 | 23 | 1.9 | 74 | 88,958 |
| VF-01 | 3 | 0.2 | 1 | 427 |
| UF-01 | 8 | 0.7 | 17 | 15,149 |
| BF-01 | 0 | 0.0 | 0 | 0 |
| CIP-02 | 3 | 0.2 | 21 | 8,362 |
| FL-01 | 29 | 2.4 | 35 | 62,418 |
| LY-01 | 5 | 0.4 | 45 | 142,947 |
| CP-01 | 14 | 1.2 | 21 | 12,303 |
| AVI-01 | 16 | 1.3 | 3 | 2,577 |
| WFI-01 | 2 | 0.2 | 21 | 30,973 |

## Batches

82 batches inoculated; 1 lost (B26080: batch lost: agitator seal failed, sterile boundary breached), 850,000 EUR. 77 drug substance lots tested (435.9 kg), 0 rejected.

## Vials

75 fill lots, 418,674 vials filled, 3,868 rejected.

| Code | Reject | Vials | Of those filled | Cost (EUR) |
| --- | --- | --- | --- | --- |
| VIS-COS | Vial rejected at inspection: cosmetic defect | 1,260 | 0.30 % | 176,400 |
| VIS-PART | Vial rejected at inspection: particles | 908 | 0.22 % | 127,120 |
| VIS-CAKE | Vial rejected at inspection: collapsed cake | 695 | 0.17 % | 97,300 |
| FIL-WT | Vial rejected by the checkweigher: fill weight | 672 | 0.16 % | 94,080 |
| VIS-CRIMP | Vial rejected at inspection: crimp defect | 333 | 0.08 % | 46,620 |
