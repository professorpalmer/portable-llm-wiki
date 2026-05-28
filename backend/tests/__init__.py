"""Marks ``backend/tests`` as a real package.

This file is load-bearing, not boilerplate. Without an ``__init__.py`` the
directory is only a *namespace* portion, and Python's import machinery will
happily resolve ``import tests`` to any *regular* ``tests`` package found
later on ``sys.path`` (e.g. a stray ``tests`` package vendored into
site-packages by another tool). When that happens, ``from tests.conftest
import OWNER_TOKEN`` loads the wrong conftest and collection dies with an
unrelated ``ImportError``. Making this a regular package means the copy at
``sys.path[0]`` (the backend dir) wins, so ``tests.conftest`` always refers
to *our* conftest regardless of what else is installed in the environment.
"""
