# Baseline metrics

Made by `tiles-sample-plant generate battery` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), and the cells' yield.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |
| --- | --- | --- | --- | --- |
| MX-C1 | 25 | 2.1 | 9 | 3,757 |
| CT-C1 | 76 | 6.3 | 47 | 84,485 |
| CL-C1 | 56 | 4.7 | 37 | 33,164 |
| SL-C1 | 45 | 3.8 | 28 | 16,720 |
| VD-C1 | 70 | 5.8 | 29 | 5,716 |
| MX-A1 | 26 | 2.2 | 13 | 5,255 |
| CT-A1 | 87 | 7.2 | 80 | 144,213 |
| CL-A1 | 50 | 4.2 | 51 | 45,762 |
| SL-A1 | 34 | 2.8 | 24 | 14,607 |
| VD-A1 | 49 | 4.1 | 22 | 4,425 |
| DR-01 | 1 | 0.1 | 4 | 10,237 |
| NT-C1 | 45 | 3.8 | 20 | 10,000 |
| NT-A1 | 43 | 3.6 | 21 | 10,610 |
| ST-01 | 334 | 27.8 | 124 | 86,784 |
| ST-02 | 325 | 27.1 | 109 | 76,199 |
| UW-01 | 62 | 5.2 | 28 | 39,606 |
| EF-01 | 58 | 4.8 | 32 | 44,213 |
| FM-01 | 2 | 0.2 | 13 | 1,906 |
| FM-02 | 1 | 0.1 | 6 | 906 |
| FM-03 | 0 | 0.0 | 0 | 0 |
| FM-04 | 0 | 0.0 | 0 | 0 |
| EOL-01 | 35 | 2.9 | 13 | 3,817 |

## Cells

692,262 cells stacked; 668,597 tested: 613,935 grade A, 44,312 grade B, 10,350 NG.

| Scrap | Cells | Of those stacked | Cost (EUR) |
| --- | --- | --- | --- |
| EOL-K | 5,590 | 0.81 % | 134,160 |
| EOL-CAP | 2,705 | 0.39 % | 64,920 |
| EOL-DCIR | 2,055 | 0.30 % | 49,320 |
| FRM-FAIL | 1,357 | 0.20 % | 32,568 |
| WLD-FAIL | 733 | 0.11 % | 17,592 |
| FIL-LOW | 657 | 0.09 % | 15,768 |
| STK-OVH | 85 | 0.01 % | 2,040 |
