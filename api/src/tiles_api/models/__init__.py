"""Models (T3.01): the registry, the registered models, and their rows in the database.

Importing this package registers every built-in model.
"""

from tiles_api.models import design as design  # registers the Design Studio models (T4.10)
from tiles_api.models import failure_modes as failure_modes  # registers die casting's failure-mode models (T8.02)
from tiles_api.models import plunger as plunger  # registers the model
from tiles_api.models import process as process  # registers the process model for recommendations (T11.01)
