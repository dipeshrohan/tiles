# Baseline metrics

Made by `tiles-sample-plant generate graphene` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), and the film's yield.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (GBP) |
| --- | --- | --- | --- | --- |
| EP-01 | 25 | 2.1 | 19 | 11,547 |
| CVD-01 | 99 | 8.2 | 88 | 131,908 |
| CVD-02 | 89 | 7.4 | 113 | 169,123 |
| CVD-03 | 80 | 6.7 | 93 | 139,849 |
| CVD-04 | 92 | 7.7 | 81 | 121,629 |
| SC-01 | 2 | 0.2 | 12 | 74,070 |
| TL-01 | 74 | 6.2 | 50 | 45,070 |
| TL-02 | 80 | 6.7 | 58 | 51,990 |
| IN-01 | 47 | 3.9 | 19 | 7,750 |
| SP-01 | 1 | 0.1 | 1 | 264 |

## Film

1,410 CVD runs; 8,268 rolls inspected: 7,410 grade A, 479 grade B, 379 NG.

| Scrap | How many | Cost (GBP) |
| --- | --- | --- |
| CVD-WRK | 15 runs | 39,000 |
| TL-TEAR | 13 runs | 33,800 |
| CVD-ABT | 3 runs | 7,800 |
| QC-RS | 308 rolls | 129,360 |
| QC-T | 37 rolls | 15,540 |
| QC-DEF | 34 rolls | 14,280 |

The etch baths were changed 114 times, 0 of them after the copper had passed 55 g/L.
