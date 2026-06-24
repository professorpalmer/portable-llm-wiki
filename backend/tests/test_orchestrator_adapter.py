"""Tests for the lock-aware Puppetmaster adapter resolution.

The orchestrator used to hardcode the ``claude`` adapter, which collided
with a Puppetmaster platform lock set to a different platform (e.g.
cursor-only) and also silently degraded when the chosen adapter's key was
missing. The durable fix is ``resolve_orchestrator_adapter``: it asks PM
which platform is both ENABLED by the lock and CONFIGURED (deps + creds),
mirroring how ``puppetmaster edit`` defaults its ``--adapter``.

These tests pin the resolution matrix and the fact that build_worker_cmd
threads the resolved adapter (and its per-adapter write flag) into the CLI.
They mock the two PM probes so the suite never shells out to a real
puppetmaster binary.
"""
from __future__ import annotations

import app.orchestrator as orch


def _reset(monkeypatch, *, override="", enabled=None, configured=None):
    """Wire the resolver's inputs deterministically and clear the cache."""
    monkeypatch.setattr(orch, "ORCHESTRATOR_ADAPTER_OVERRIDE", override)
    monkeypatch.setattr(orch, "_resolved_adapter_cache", None)
    monkeypatch.setattr(orch, "_pm_enabled_platforms", lambda: enabled)
    monkeypatch.setattr(orch, "_pm_configured_adapters", lambda: configured)


def test_override_wins_verbatim(monkeypatch):
    _reset(monkeypatch, override="codex", enabled={"cursor"}, configured={"cursor"})
    assert orch.resolve_orchestrator_adapter() == "codex"


def test_unreadable_lock_falls_back_to_claude(monkeypatch):
    # PM missing / older PM without --json -> preserve historical default.
    _reset(monkeypatch, enabled=None, configured=None)
    assert orch.resolve_orchestrator_adapter() == "claude"


def test_picks_enabled_and_configured_platform(monkeypatch):
    _reset(
        monkeypatch,
        enabled={"claude-code"},
        configured={"claude-code", "local", "shell"},
    )
    # claude-code platform maps to the ``claude`` invocation verb.
    assert orch.resolve_orchestrator_adapter() == "claude"


def test_skips_enabled_but_unconfigured_for_a_configured_one(monkeypatch):
    # cursor is enabled but has no CURSOR_API_KEY; claude is enabled AND
    # configured -> claude wins (the intersection, not just the lock).
    _reset(
        monkeypatch,
        enabled={"cursor", "claude-code"},
        configured={"claude-code"},
    )
    assert orch.resolve_orchestrator_adapter() == "claude"


def test_lock_only_unconfigured_still_respects_lock(monkeypatch):
    # The real production case: lock is cursor-only and cursor is NOT
    # configured. We must NOT silently fall through to a locked-off claude;
    # we return cursor (its verb) and let PM emit its own actionable error.
    _reset(monkeypatch, enabled={"cursor"}, configured=set())
    assert orch.resolve_orchestrator_adapter() == "cursor"


def test_resolution_is_cached(monkeypatch):
    calls = {"n": 0}

    def counting_enabled():
        calls["n"] += 1
        return {"claude-code"}

    monkeypatch.setattr(orch, "ORCHESTRATOR_ADAPTER_OVERRIDE", "")
    monkeypatch.setattr(orch, "_resolved_adapter_cache", None)
    monkeypatch.setattr(orch, "_pm_enabled_platforms", counting_enabled)
    monkeypatch.setattr(orch, "_pm_configured_adapters", lambda: {"claude-code"})

    a = orch.resolve_orchestrator_adapter()
    b = orch.resolve_orchestrator_adapter()
    assert a == b == "claude"
    # The lock probe ran exactly once; the second call hit the cache.
    assert calls["n"] == 1


def test_build_worker_cmd_threads_resolved_adapter_and_write_flag(monkeypatch):
    # cursor resolved -> verb is 'cursor' AND the write path adds --implement.
    monkeypatch.setattr(orch, "resolve_orchestrator_adapter", lambda: "cursor")
    cmd = orch.build_worker_cmd("do a thing", cwd="/tmp/wiki", timeout_seconds=120, write=True)
    assert cmd[1] == "cursor"
    assert "do a thing" in cmd
    assert "--allow-dirty" in cmd
    assert "--implement" in cmd
    # claude resolved -> verb 'claude' AND --permission-mode acceptEdits.
    monkeypatch.setattr(orch, "resolve_orchestrator_adapter", lambda: "claude")
    cmd2 = orch.build_worker_cmd("x", cwd="/tmp/wiki", timeout_seconds=120, write=True)
    assert cmd2[1] == "claude"
    assert "--permission-mode" in cmd2 and "acceptEdits" in cmd2
    assert "--implement" not in cmd2


def test_build_worker_cmd_no_write_omits_edit_flags(monkeypatch):
    monkeypatch.setattr(orch, "resolve_orchestrator_adapter", lambda: "cursor")
    cmd = orch.build_worker_cmd("analyze", cwd="/tmp/wiki", timeout_seconds=60, write=False)
    assert "--implement" not in cmd
    assert "--allow-dirty" not in cmd
