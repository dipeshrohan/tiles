# Baseline metrics

Made by `tiles-sample-plant generate battery` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), and the cells' yield. The dry room's stops stop the assembly
line too (DT-DRM on each of its machines in the MES); they are counted once, on DR-01.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |
| --- | --- | --- | --- | --- |
| MX-C1 | 25 | 2.1 | 9 | 3,757 |
| CT-C1 | 76 | 6.3 | 47 | 84,485 |
| CL-C1 | 56 | 4.7 | 37 | 33,164 |
| SL-C1 | 45 | 3.8 | 28 | 16,720 |
| VD-C1 | 70 | 5.8 | 29 | 5,716 |
| MX-A1 | 26 | 2.2 | 13 | 5,255 |
| CT-A1 | 85 | 7.1 | 75 | 135,348 |
| CL-A1 | 51 | 4.2 | 41 | 37,120 |
| SL-A1 | 36 | 3.0 | 28 | 16,999 |
| VD-A1 | 49 | 4.1 | 22 | 4,425 |
| DR-01 | 1 | 0.1 | 4 | 10,237 |
| NT-C1 | 44 | 3.7 | 16 | 8,172 |
| NT-A1 | 42 | 3.5 | 18 | 8,781 |
| ST-01 | 339 | 28.2 | 120 | 84,025 |
| ST-02 | 332 | 27.7 | 110 | 77,207 |
| UW-01 | 61 | 5.1 | 25 | 34,487 |
| EF-01 | 57 | 4.8 | 28 | 39,105 |
| FM-01 | 10 | 0.8 | 20 | 2,976 |
| FM-02 | 12 | 1.0 | 21 | 3,110 |
| FM-03 | 10 | 0.8 | 8 | 1,187 |
| FM-04 | 9 | 0.8 | 11 | 1,699 |
| EOL-01 | 35 | 2.9 | 13 | 3,817 |

## Cells

691,163 cells stacked; 666,658 tested: 618,043 grade A, 40,536 grade B, 8,079 NG.

| Scrap | Cells | Of those stacked | Cost (EUR) |
| --- | --- | --- | --- |
| EOL-K | 5,599 | 0.81 % | 134,376 |
| EOL-DCIR | 1,825 | 0.26 % | 43,800 |
| FRM-FAIL | 1,343 | 0.19 % | 32,232 |
| WLD-FAIL | 699 | 0.10 % | 16,776 |
| FIL-LOW | 657 | 0.10 % | 15,768 |
| EOL-CAP | 655 | 0.09 % | 15,720 |
| STK-OVH | 65 | 0.01 % | 1,560 |
