import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def run():
    """Run a coroutine to completion (no pytest-asyncio dependency)."""
    def _run(coro):
        return asyncio.run(coro)
    return _run


@pytest.fixture
def store(tmp_path):
    from helpers import Store
    return Store(str(tmp_path))
