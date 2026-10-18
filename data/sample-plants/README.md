# Sample plants

Made-up plants, each a year of one industry, complete as a design partner would hand it over at the
assessment ([T2.16](../../docs/pilot/assessment.md)): the plant model, tags, historian readings, the
MES's or batch records' events, quality results, maintenance work orders, lab tests, costs,
documents, a copilot question set answerable from the data, and the ground truth of what happened.
Each is simulated from the physics and the routines of its plant, so problems show in the signals
before they stop the line, as they would at a real one; the same seed gives the same year.

| Plant | Industry | What it makes |
| --- | --- | --- |
| [die-casting](die-casting/README.md) | High-pressure aluminium die casting | Transmission and e-motor housings, covers, brackets |

From `api/`:

```sh
uv run tiles-sample-plant generate <plant> [--all]    # write its files; --all adds the large ones
uv run tiles-sample-plant load <plant> --site <id> --as <engineer's email>
```

`api/tests/test_sample_<plant>.py` checks each plant's committed files are what its generator
makes, that its year behaves as its industry's would, and that its copilot questions are answered
from it once it is loaded into a site.
