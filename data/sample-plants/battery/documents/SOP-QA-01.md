# SOP-QA-01: End-of-line test and grading

Applies to the tester EOL-01. Owner: quality.

Every cell is tested for capacity, DC internal resistance (DCIR) and its K-value, and graded:

| Grade | Capacity | DCIR | K-value |
| --- | --- | --- | --- |
| A | 60.0 Ah or more | 0.90 mΩ or less | 0.20 mV/day or less |
| B | 58.8 Ah or more | 0.95 mΩ or less | 0.25 mV/day or less |
| NG | otherwise | | |

A cell needs 60.0 Ah, at most 0.90 mΩ and a K-value of at most 0.20 mV a day for grade A.
An NG cell is scrapped for its worst fault: self-discharge (EOL-K), resistance (EOL-DCIR) or
capacity (EOL-CAP). A scrapped cell costs about 24 EUR.
