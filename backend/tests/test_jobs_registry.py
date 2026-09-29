"""The job registry stays bounded and settles jobs orphaned by a restart."""
import os
import subprocess
import sys

from app import orchestrator
from app.orchestrator import TrackedJob


def _job(i, status="done", pid=None):
    return TrackedJob(tracking_id=f"t{i:04d}", kind="ingest", raw_path="raw/x.md", note="",
                      started_at=f"2026-09-01T00:{i // 60:02d}:{i % 60:02d}", cwd="/w",
                      log_path="/l", status=status, pid=pid)


def test_settled_history_is_capped_and_running_jobs_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "JOBS_FILE", tmp_path / "jobs.json")
    jobs = {j.tracking_id: j for j in (_job(i) for i in range(orchestrator.JOBS_HISTORY_CAP + 50))}
    jobs["live"] = _job(0, status="running", pid=os.getpid())
    jobs["live"].tracking_id = "live"
    orchestrator._save_jobs(jobs)
    kept = orchestrator._load_jobs()
    assert "live" in kept
    settled = [k for k, j in kept.items() if j.status != "running"]
    assert len(settled) == orchestrator.JOBS_HISTORY_CAP
    assert "t0000" not in kept and f"t{orchestrator.JOBS_HISTORY_CAP + 49:04d}" in kept


def test_startup_settles_jobs_whose_worker_is_gone(tmp_path, monkeypatch):
    monkeypatch.setattr(orchestrator, "JOBS_FILE", tmp_path / "jobs.json")
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    jobs = {"gone": _job(1, status="running", pid=dead.pid), "alive": _job(2, status="running", pid=os.getpid())}
    jobs["gone"].tracking_id, jobs["alive"].tracking_id = "gone", "alive"
    orchestrator._save_jobs(jobs)
    assert orchestrator.reconcile_orphaned_jobs() == 1
    after = orchestrator._load_jobs()
    assert after["gone"].status == "error" and "Interrupted" in after["gone"].summary
    assert after["alive"].status == "running"
