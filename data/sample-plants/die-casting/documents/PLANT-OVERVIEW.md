# Kesselbach plant: overview

Aldermoor Castings' Kesselbach plant casts aluminium housings and brackets for car makers and their
suppliers: transmission housings, e-motor housings, gearbox covers and mounting brackets.

## Die-casting cells

| Cell | Line | Machine | Locking force | Built | Products |
| --- | --- | --- | --- | --- | --- |
| DC-01 | Line 2 | Bühler Carat 220 | 22,000 kN | 2019 | TH-410 |
| DC-02 | Line 2 | Bühler Carat 220 | 22,000 kN | 2019 | TH-410 |
| DC-03 | Line 2 | Bühler Carat 160 | 16,000 kN | 2021 | EM-220 |
| DC-04 | Line 2 | Idra OL 1600 S | 16,000 kN | 2017 | EM-220, CV-90 |
| DC-05 | Line 1 | Idra OL 800 | 8,000 kN | 2009 | BR-35 |
| DC-06 | Line 1 | Idra OL 800 | 8,000 kN | 2010 | BR-35, CV-90 |

Each cell has a holding furnace (HF), a spray robot (SR), an extraction robot (ER), a trim press (TP)
and a vacuum unit (VU), controlled by the cell's PLC. Line 2's cells are the pilot: their PLCs
(Siemens S7-1500) serve OPC UA and every shot is logged. Line 1's older cells (S7-300) send two
five-minute averages over MQTT.

## Shifts

Three shifts (night 22:00 to 06:00 from Sunday night, early 06:00 to 14:00, late 14:00 to 22:00) on
weekdays, and a Saturday early shift except in July, August and December. Crews A, B and C rotate weekly.

## Who acts on a warning

The shift lead of Line 2 (crews A, B, C) receives the warnings and calls the maintenance technician of
the shift. The maintenance lead decides whether a warning was a true alarm. The process engineer
owns the shot settings and the quality lead the X-ray grades and quality holds.

## Costs (controlling, 2026)

A stop costs 3,100 EUR an hour on DC-01 and DC-02, 2,700 EUR on DC-03,
2,400 EUR on DC-04 and 900 EUR on Line 1's cells. A scrapped part
costs 48 EUR (TH-410), 36 EUR (EM-220), 14 EUR (CV-90), 6 EUR (BR-35).
