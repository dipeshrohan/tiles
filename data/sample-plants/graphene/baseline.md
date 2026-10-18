# Baseline metrics

Made by `tiles-sample-plant generate graphene` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), and the film's yield. The scrubber's trips stop the CVD
hall (DT-EXH on each reactor in the MES); they are costed once, on SC-01.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (GBP) |
| --- | --- | --- | --- | --- |
| EP-01 | 25 | 2.1 | 19 | 11,547 |
| CVD-01 | 92 | 7.7 | 78 | 116,501 |
| CVD-02 | 88 | 7.3 | 104 | 156,595 |
| CVD-03 | 89 | 7.4 | 86 | 128,664 |
| CVD-04 | 87 | 7.2 | 71 | 106,674 |
| SC-01 | 2 | 0.2 | 12 | 74,070 |
| TL-01 | 70 | 5.8 | 49 | 43,887 |
| TL-02 | 78 | 6.5 | 53 | 47,712 |
| IN-01 | 46 | 3.8 | 19 | 7,679 |
| SP-01 | 1 | 0.1 | 1 | 264 |

## Film

1,376 CVD runs; 8,064 rolls inspected: 7,127 grade A, 558 grade B, 379 NG.

| Scrap | How many | Cost (GBP) |
| --- | --- | --- |
| CVD-WRK | 13 runs | 33,800 |
| TL-TEAR | 11 runs | 28,600 |
| CVD-ABT | 7 runs | 18,200 |
| QC-RS | 304 rolls | 127,680 |
| QC-DEF | 41 rolls | 17,220 |
| QC-T | 34 rolls | 14,280 |

The etch baths were changed 111 times, 0 of them after the copper had passed 55 g/L.
