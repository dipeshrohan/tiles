# Baseline metrics

Made by `tiles-sample-plant generate biologics` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), the batches and the vials.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |
| --- | --- | --- | --- | --- |
| WB-01 | 3 | 0.2 | 4 | 655 |
| WB-02 | 3 | 0.2 | 4 | 619 |
| SB-01 | 6 | 0.5 | 5 | 1,972 |
| SB-02 | 6 | 0.5 | 8 | 3,136 |
| BR-01 | 6 | 0.5 | 6 | 14,784 |
| BR-02 | 8 | 0.7 | 36 | 89,874 |
| BR-03 | 4 | 0.3 | 5 | 11,980 |
| BR-04 | 4 | 0.3 | 36 | 89,268 |
| MP-01 | 5 | 0.4 | 22 | 6,503 |
| CIP-01 | 5 | 0.4 | 24 | 14,421 |
| CF-01 | 7 | 0.6 | 18 | 21,891 |
| DF-01 | 2 | 0.2 | 1 | 226 |
| BP-01 | 9 | 0.8 | 23 | 6,909 |
| CS-01 | 7 | 0.6 | 3 | 5,065 |
| VT-01 | 4 | 0.3 | 1 | 248 |
| CS-02 | 21 | 1.8 | 79 | 95,287 |
| VF-01 | 3 | 0.2 | 1 | 427 |
| UF-01 | 5 | 0.4 | 10 | 9,276 |
| BF-01 | 0 | 0.0 | 0 | 0 |
| CIP-02 | 3 | 0.2 | 17 | 6,995 |
| FL-01 | 27 | 2.2 | 26 | 47,518 |
| LY-01 | 5 | 0.4 | 45 | 142,947 |
| CP-01 | 12 | 1.0 | 11 | 6,775 |
| AVI-01 | 15 | 1.2 | 3 | 2,317 |
| WFI-01 | 2 | 0.2 | 21 | 30,973 |

## Batches

79 batches inoculated; 2 lost (B26062: batch lost: agitator seal failed, sterile boundary breached, B26078: batch lost: agitator seal failed, sterile boundary breached), 1,700,000 EUR. 73 drug substance lots tested (409.3 kg), 1 rejected (DS26047).

## Vials

70 fill lots, 387,708 vials filled, 3,306 rejected.

| Code | Reject | Vials | Of those filled | Cost (EUR) |
| --- | --- | --- | --- | --- |
| VIS-COS | Vial rejected at inspection: cosmetic defect | 1,167 | 0.30 % | 163,380 |
| VIS-PART | Vial rejected at inspection: particles | 849 | 0.22 % | 118,860 |
| VIS-CAKE | Vial rejected at inspection: collapsed cake | 515 | 0.13 % | 72,100 |
| FIL-WT | Vial rejected by the checkweigher: fill weight | 476 | 0.12 % | 66,640 |
| VIS-CRIMP | Vial rejected at inspection: crimp defect | 299 | 0.08 % | 41,860 |
