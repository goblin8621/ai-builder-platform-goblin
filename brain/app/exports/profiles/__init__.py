"""Importing this package registers every built-in Target."""
from . import claude, generic  # noqa: F401  (registration side effects)
from .registry import (  # noqa: F401
    FormatDefinition,
    TargetDefinition,
    get_format,
    get_target,
    list_targets,
    register_target,
    resolve_profile,
    unregister_target,
)
