# SOP-USP-03: Agitator mechanical seals

Applies to the production bioreactors' agitators. Owner: maintenance and reliability.

Each agitator has a double mechanical seal with a pressurised barrier fluid. Its loss (`seal_loss`)
is logged every 5 minutes. Normally a seal loses about 0.6 mL/h of barrier fluid.

- A seal losing more than 3 mL/h of barrier fluid is replaced at the next turnaround.
- At 6 mL/h the seal has reached its limit: the sterile boundary is at risk.
- A seal that fails during a batch breaches the sterile boundary: the batch is lost (BATCH-SEAL) and
  the reactor stops for the seal's replacement (DT-SEAL). A worn seal also makes a contamination
  likelier.

Each bioreactor has a 36-hour maintenance every 6 batches: seals, valves and probes.
