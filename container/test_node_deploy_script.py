from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "deploy-login-node.sh"
).read_text()


def test_node_rollback_uses_the_backups_own_health_contract():
    assert "health-contract" in SCRIPT
    assert 'expected_api_version="$4"' not in SCRIPT


def test_node_rollback_never_swallows_restart_failure():
    assert "systemctl restart cqu-login || true" not in SCRIPT


def test_partial_live_tree_switch_is_trapped_and_rolled_back():
    assert "absent-files" in SCRIPT
    assert "rollback_on_error" in SCRIPT
    assert "trap 'rollback_on_error $?' ERR" in SCRIPT
    assert "trap 'rollback_on_error 129' HUP" in SCRIPT
    assert "trap 'rollback_on_error 130' INT" in SCRIPT
    assert "trap 'rollback_on_error 143' TERM" in SCRIPT
    assert 'sudo rm -f -- "$app_dir/$file"' in SCRIPT


def test_rollback_manifest_is_root_owned_allowlisted_and_fail_closed():
    assert 'is_runtime_file "$file" || return 1' in SCRIPT
    assert 'install -o root -g root -m 0644 /dev/null "$backup_dir/absent-files"' in SCRIPT
    assert 'sudo install -o root -g root -m 0644 "$app_dir/$file" "$backup_dir/$file"' in SCRIPT
    assert 'sudo install -o cqulogin -g cqulogin -m 0644 "$source" "$app_dir/$file" || return 1' in SCRIPT
    assert 'sudo rm -f -- "$app_dir/$file" || return 1' in SCRIPT
    assert 'sudo systemctl restart cqu-login || return 1' in SCRIPT


def test_release_and_rollback_ids_cannot_escape_the_release_root():
    assert '"$1" != "." && "$1" != ".."' in SCRIPT
    assert 'backup_dir_real="$(cd "$backup_dir" && pwd -P)"' in SCRIPT
    assert '[[ "$backup_dir_real" == "$release_root_real/"* ]]' in SCRIPT
