"""Minimal structured logger mirroring bff/src/logging/index.ts.

Every log line carries request_id when available so BFF <-> Brain calls
can be correlated (05번 문서 Correlation ID 원칙).
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


def _emit(level: str, msg: str, **fields: Any) -> None:
    line = {
        "level": level,
        "msg": msg,
        "time": datetime.now(timezone.utc).isoformat(),
        **fields,
    }
    stream = sys.stderr if level == "error" else sys.stdout
    print(json.dumps(line), file=stream)


def info(msg: str, **fields: Any) -> None:
    _emit("info", msg, **fields)


def warn(msg: str, **fields: Any) -> None:
    _emit("warn", msg, **fields)


def error(msg: str, **fields: Any) -> None:
    _emit("error", msg, **fields)
