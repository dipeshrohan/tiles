# Baseline metrics

Made by `tiles-sample-plant generate graphene` from the simulated year: each machine's unplanned
stops (a stop continued into the next shift counts once; its hours in full) and their cost at
controlling's figures (plant/costs.csv), and the film's yield.

## Stops

| Machine | Unplanned stops | A month | Hours | Cost of the hours (GBP) |
| --- | --- | --- | --- | --- |
| EP-01 | 25 | 2.1 | 19 | 11,547 |
| CVD-01 | 94 | 7.8 | 90 | 135,018 |
| CVD-02 | 85 | 7.1 | 110 | 165,271 |
| CVD-03 | 86 | 7.2 | 89 | 133,503 |
| CVD-04 | 90 | 7.5 | 85 | 127,168 |
| SC-01 | 2 | 0.2 | 12 | 74,070 |
| TL-01 | 74 | 6.2 | 50 | 45,070 |
| TL-02 | 79 | 6.6 | 58 | 52,177 |
| IN-01 | 46 | 3.8 | 19 | 7,679 |
| SP-01 | 1 | 0.1 | 1 | 264 |

## Film

1,405 CVD runs; 8,172 rolls inspected: 7,343 grade A, 443 grade B, 386 NG.

| Scrap | How many | Cost (GBP) |
| --- | --- | --- |
| TL-TEAR | 19 runs | 49,400 |
| CVD-WRK | 15 runs | 39,000 |
| CVD-ABT | 8 runs | 20,800 |
| QC-RS | 307 rolls | 128,940 |
| QC-DEF | 43 rolls | 18,060 |
| QC-T | 36 rolls | 15,120 |

The etch baths were changed 113 times, 0 of them after the copper had passed 55 g/L.
