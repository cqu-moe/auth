from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "deploy-login-node.sh"
).read_text()


def test_node_rollback_uses_the_backups_own_health_contract():
    assert "health-contract" in SCRIPT
    assert 'expected_api_version="$4"' not in SCRIPT


def test_node_rollback_never_swallows_restart_failure():
    assert "systemctl restart cqu-login || true" not in SCRIPT
