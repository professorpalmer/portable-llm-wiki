"""Process-global jobs/swarms must not leak across tenants."""
from __future__ import annotations

from pathlib import Path

from app import lint_swarm, orchestrator, tenants


def _job(
    tracking_id: str,
    cwd: str,
    tenant_id: str | None,
    started_at: str = "2026-08-15T00:00:00Z",
) -> orchestrator.TrackedJob:
    return orchestrator.TrackedJob(
        tracking_id=tracking_id,
        kind="ingest",
        raw_path="raw/x.md",
        note="",
        started_at=started_at,
        cwd=cwd,
        log_path="unused.log",
        tenant_id=tenant_id,
    )


def test_jobs_filtered_by_tenant_and_legacy_cwd(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "JOBS_FILE", tmp_path / "jobs.json")
    alice_root = tmp_path / "alice"
    bob_root = tmp_path / "bob"
    alice_root.mkdir()
    bob_root.mkdir()
    alice = tenants.Tenant(id="alice", wiki_root=alice_root)
    bob = tenants.Tenant(id="bob", wiki_root=bob_root)

    orchestrator._save_jobs(
        {
            "alice-job": _job("alice-job", str(alice_root), "alice"),
            "bob-job": _job("bob-job", str(bob_root), "bob"),
            "legacy-alice": _job("legacy-alice", str(alice_root), None),
            "legacy-bob": _job("legacy-bob", str(bob_root), None),
        }
    )

    with tenants.set_current_tenant(alice):
        ids = {j.tracking_id for j in orchestrator.list_jobs()}
        assert ids == {"alice-job", "legacy-alice"}
        assert orchestrator.get_job("alice-job") is not None
        assert orchestrator.get_job("bob-job") is None
        assert orchestrator.get_job("legacy-bob") is None
        assert orchestrator.get_job("missing") is None

    with tenants.set_current_tenant(bob):
        ids = {j.tracking_id for j in orchestrator.list_jobs()}
        assert ids == {"bob-job", "legacy-bob"}
        assert orchestrator.get_job("alice-job") is None


def test_swarms_filtered_by_tenant_and_legacy_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(lint_swarm, "SWARMS_FILE", tmp_path / "swarms.json")
    alice_root = tmp_path / "alice"
    bob_root = tmp_path / "bob"
    (alice_root / ".lint" / "s1").mkdir(parents=True)
    (bob_root / ".lint" / "s2").mkdir(parents=True)
    alice = tenants.Tenant(id="alice", wiki_root=alice_root)
    bob = tenants.Tenant(id="bob", wiki_root=bob_root)

    recs = {
        "alice-swarm": lint_swarm.LintSwarmRecord(
            swarm_id="alice-swarm",
            started_at="2026-08-15T00:00:00Z",
            artifacts_dir=str(alice_root / ".lint" / "s1"),
            tenant_id="alice",
        ),
        "bob-swarm": lint_swarm.LintSwarmRecord(
            swarm_id="bob-swarm",
            started_at="2026-08-15T00:00:01Z",
            artifacts_dir=str(bob_root / ".lint" / "s2"),
            tenant_id="bob",
        ),
        "legacy-alice": lint_swarm.LintSwarmRecord(
            swarm_id="legacy-alice",
            started_at="2026-08-15T00:00:02Z",
            artifacts_dir=str(alice_root / ".lint" / "s1"),
            tenant_id=None,
        ),
    }
    lint_swarm._save_swarms(recs)

    with tenants.set_current_tenant(alice):
        ids = {r.swarm_id for r in lint_swarm.list_swarms()}
        assert ids == {"alice-swarm", "legacy-alice"}
        assert lint_swarm.get_swarm("bob-swarm") is None
        assert lint_swarm.get_swarm("alice-swarm") is not None

    with tenants.set_current_tenant(bob):
        ids = {r.swarm_id for r in lint_swarm.list_swarms()}
        assert ids == {"bob-swarm"}
        assert lint_swarm.get_swarm("legacy-alice") is None
