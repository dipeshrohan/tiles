# SOP-DC-04: Plunger tip and shot sleeve: inspection and change

Applies to every die-casting machine. Owner: maintenance.

## The planned change

The plunger tip is changed every 20,000 shots, by the shot counter of the tip (HMI page "Shot end").
The change takes 35 to 55 minutes and is booked as PL-TIP. Lubricate the tip every shift.

## Watching the tip between changes

The shot cylinder pressure in the slow phase (tag `dcNN.plunger_pressure_1st`) shows the friction on
the plunger. With a new tip it reads about 15 bar; near the end of a tip's life about 21 bar.

- Over 25 bar: inspect the tip and the sleeve at the next stop.
- Over 30 bar: change the tip now. A scored tip seizes within hours to days.
- 36 bar is the wear limit: do not run the machine above it.

A seized plunger (DT-PLG) stops the cell for four to eight hours: the tip and often the shot sleeve
are changed, and the sleeve is honed. The shot sleeve (6,800 EUR) costs sixteen times as much as a
tip (420 EUR).
