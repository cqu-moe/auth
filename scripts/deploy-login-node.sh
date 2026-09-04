#!/usr/bin/env bash
set -euo pipefail

node_host="${CQU_LOGIN_NODE_HOST:-tencent-cd-cqu-moe}"
app_dir="/opt/cqu-login/app"
release_root="/opt/cqu-login/releases"
expected_api_version="atrust-harvest-v1"
runtime_files=(
  server.py
  cqu_login.py
  cqu_atrust.py
  qg_proxy.py
  cqu_ticket.py
  cqu_ticket_browser.py
  cqu_keepalive.py
  cqu_data_harvest.py
)

usage() {
  echo "usage: $0 <release-id> | --rollback <backup-id>" >&2
  exit 2
}

validate_id() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || usage
}

if [[ "${1:-}" == "--rollback" ]]; then
  backup_id="${2:-}"
  validate_id "$backup_id"
  ssh "$node_host" bash -s -- "$backup_id" "$app_dir" "$release_root" <<'REMOTE'
set -euo pipefail
backup_id="$1"
app_dir="$2"
release_root="$3"
backup_dir="$release_root/$backup_id"
contract_file="$backup_dir/health-contract"
[[ -d "$backup_dir" ]] || { echo "backup not found: $backup_id" >&2; exit 1; }
[[ -f "$contract_file" ]] || { echo "backup health contract missing: $backup_id" >&2; exit 1; }
for source in "$backup_dir"/*.py; do
  [[ -e "$source" ]] || continue
  sudo install -o cqulogin -g cqulogin -m 0644 "$source" "$app_dir/$(basename "$source")"
done
sudo systemctl restart cqu-login
for _ in $(seq 1 20); do
  if payload=$(curl -fsS --max-time 3 http://127.0.0.1:8080/health 2>/dev/null) && \
     CONTRACT="$(cat "$contract_file")" PAYLOAD="$payload" /opt/cqu-login/venv/bin/python -c 'import json, os; body=json.loads(os.environ["PAYLOAD"]); assert body["ok"] is True; expected=os.environ["CONTRACT"]; assert expected == "legacy-ok" or body.get("apiVersion") == expected'; then
    echo "rollback healthy: $backup_id"
    exit 0
  fi
  sleep 1
done
sudo systemctl status cqu-login --no-pager >&2 || true
exit 1
REMOTE
  exit 0
fi

release_id="${1:-}"
validate_id "$release_id"
staging_dir="/tmp/cqu-login-$release_id"

ssh "$node_host" "install -d -m 0700 '$staging_dir'"
rsync -a --chmod=F600 \
  "${runtime_files[@]/#/container/}" \
  "$node_host:$staging_dir/"

ssh "$node_host" bash -s -- \
  "$release_id" "$staging_dir" "$app_dir" "$release_root" "$expected_api_version" \
  "${runtime_files[@]}" <<'REMOTE'
set -euo pipefail
release_id="$1"
staging_dir="$2"
app_dir="$3"
release_root="$4"
expected_api_version="$5"
shift 5
runtime_files=("$@")
release_dir="$release_root/$release_id"
backup_id="backup-$(date -u +%Y%m%dT%H%M%SZ)-$release_id"
backup_dir="$release_root/$backup_id"

sudo install -d -o cqulogin -g cqulogin -m 0755 "$release_root" "$release_dir" "$backup_dir"
previous_payload=$(curl -fsS --max-time 3 http://127.0.0.1:8080/health)
previous_contract=$(PAYLOAD="$previous_payload" /opt/cqu-login/venv/bin/python -c 'import json, os; body=json.loads(os.environ["PAYLOAD"]); assert body["ok"] is True; print(body.get("apiVersion") or "legacy-ok")')
printf '%s\n' "$previous_contract" | sudo tee "$backup_dir/health-contract" >/dev/null
sudo chmod 0644 "$backup_dir/health-contract"
for file in "${runtime_files[@]}"; do
  sudo install -o cqulogin -g cqulogin -m 0644 "$staging_dir/$file" "$release_dir/$file"
  if [[ -f "$app_dir/$file" ]]; then
    sudo cp -p "$app_dir/$file" "$backup_dir/$file"
  fi
done

# Worker 切流前的静态 gate：新 release 必须能加载全部新增模块。
(
  cd "$release_dir"
  /opt/cqu-login/venv/bin/python -c 'import cqu_atrust, cqu_data_harvest, server; assert server.NODE_API_VERSION == "atrust-harvest-v1"'
)

rollback() {
  for source in "$backup_dir"/*.py; do
    [[ -e "$source" ]] || continue
    sudo install -o cqulogin -g cqulogin -m 0644 "$source" "$app_dir/$(basename "$source")"
  done
  sudo systemctl restart cqu-login
  for _ in $(seq 1 20); do
    if payload=$(curl -fsS --max-time 3 http://127.0.0.1:8080/health 2>/dev/null) && \
       CONTRACT="$(cat "$backup_dir/health-contract")" PAYLOAD="$payload" /opt/cqu-login/venv/bin/python -c 'import json, os; body=json.loads(os.environ["PAYLOAD"]); assert body["ok"] is True; expected=os.environ["CONTRACT"]; assert expected == "legacy-ok" or body.get("apiVersion") == expected'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

for file in "${runtime_files[@]}"; do
  sudo install -o cqulogin -g cqulogin -m 0644 "$release_dir/$file" "$app_dir/$file"
done

if ! sudo systemctl restart cqu-login; then
  if ! rollback; then
    echo "node restart and automatic rollback both failed" >&2
  fi
  exit 1
fi

healthy=0
for _ in $(seq 1 20); do
  if payload=$(curl -fsS --max-time 3 http://127.0.0.1:8080/health 2>/dev/null) && \
     EXPECTED_API_VERSION="$expected_api_version" PAYLOAD="$payload" /opt/cqu-login/venv/bin/python -c 'import json, os; body=json.loads(os.environ["PAYLOAD"]); assert body["ok"] is True; assert body["apiVersion"] == os.environ["EXPECTED_API_VERSION"]; required={"atrust-login","code-permit","reusable-code","data-harvest"}; assert required <= set(body["capabilities"])'; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "$healthy" != 1 ]]; then
  sudo systemctl status cqu-login --no-pager >&2 || true
  if rollback; then
    echo "node health gate failed; rollback verified: $backup_id" >&2
  else
    echo "node health gate failed; rollback also failed: $backup_id" >&2
  fi
  exit 1
fi

rm -rf "$staging_dir"
echo "node release healthy: $release_id"
echo "rollback id: $backup_id"
REMOTE
