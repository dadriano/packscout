#!/usr/bin/env bash
# Restart launchd-managed PackScout development services on macOS.
#
# Usage:
#   ./scripts/local/restart.sh
#   ./scripts/local/restart.sh frontend
#   ./scripts/local/restart.sh admin worker
#   ./scripts/local/restart.sh --clean frontend
#   ./scripts/local/restart.sh --frontend-mode standard frontend
#   ./scripts/local/restart.sh --frontend-mode mock frontend
#   ./scripts/local/restart.sh --frontend-mode mock-heat frontend
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
FRONTEND_MODE="standard"
CLEAN=false
MAX_ATTEMPTS="${PACKSCOUT_RESTART_MAX_ATTEMPTS:-120}"
POLL_SECONDS="${PACKSCOUT_RESTART_POLL_SECONDS:-1}"
WORKER_STABILITY_POLLS="${PACKSCOUT_RESTART_WORKER_STABILITY_POLLS:-5}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/local/restart.sh [options] [frontend|admin|worker ...]

Restart PackScout's macOS launchd-managed local development services. With no
service names, all three services restart.

Options:
  --clean                         Remove selected frontend build caches first
  --frontend-mode <mode>          standard | mock | mock-heat (default: standard)
  --help, -h                      Show this help

The script must run from PackScout's primary checkout. It never copies secrets
into launchd plists; admin and worker continue loading the ignored root .env.
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0) return 1 ;;
    *) return 0 ;;
  esac
}

is_nonnegative_duration() {
  case "$1" in
    ''|*[!0-9.]*) return 1 ;;
    *.*.*) return 1 ;;
    .|.*|*.) return 1 ;;
    *) return 0 ;;
  esac
}

targets=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=true
      shift
      ;;
    --frontend-mode)
      [[ $# -ge 2 ]] || fail "--frontend-mode requires a value."
      FRONTEND_MODE="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      fail "Unknown option: $1"
      ;;
    frontend|admin|worker)
      case " $targets " in
        *" $1 "*) ;;
        *) targets="${targets}${targets:+ }$1" ;;
      esac
      shift
      ;;
    *)
      fail "Unknown service: $1 (valid: frontend, admin, worker)"
      ;;
  esac
done

case "$FRONTEND_MODE" in
  standard|mock|mock-heat) ;;
  *) fail "Unknown frontend mode: $FRONTEND_MODE (valid: standard, mock, mock-heat)" ;;
esac
[[ -n "$targets" ]] || targets="frontend admin worker"
is_positive_integer "$MAX_ATTEMPTS" || fail "PACKSCOUT_RESTART_MAX_ATTEMPTS must be a positive integer."
is_positive_integer "$WORKER_STABILITY_POLLS" || fail "PACKSCOUT_RESTART_WORKER_STABILITY_POLLS must be a positive integer."
is_nonnegative_duration "$POLL_SECONDS" || fail "PACKSCOUT_RESTART_POLL_SECONDS must be a nonnegative duration."

[[ "$(uname -s)" == "Darwin" ]] || fail "PackScout launchd restart is supported only on macOS."
for command_name in git launchctl lsof npm node plutil curl install mktemp ps sed; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not a Git workspace: $ROOT"
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
primary_root="$(cd "$(dirname "$common_dir")" && pwd -P)"
[[ "$ROOT" == "$primary_root" ]] || fail "Run this command from PackScout's primary checkout: $primary_root"

UID_NUMBER="$(id -u)"
LOCK_DIR="${TMPDIR:-/tmp}/dev.packscout.maintenance.$UID_NUMBER.lock"
LOCK_HELD=false

release_restart_lock() {
  if [[ "$LOCK_HELD" == true ]]; then
    rm -f "$LOCK_DIR/owner"
    rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
    LOCK_HELD=false
  fi
}

trap release_restart_lock EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

INHERITED_LOCK_PID="${PACKSCOUT_MAINTENANCE_LOCK_OWNER_PID:-}"
if [[ -n "$INHERITED_LOCK_PID" ]]; then
  case "$INHERITED_LOCK_PID" in
    *[!0-9]*|0) fail "PACKSCOUT_MAINTENANCE_LOCK_OWNER_PID must be a positive integer." ;;
  esac
  [[ -f "$LOCK_DIR/owner" ]] \
    || fail "Cannot validate the inherited PackScout maintenance lock."
  inherited_owner_pid="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" | sed -n '1p')"
  inherited_owner_root="$(sed -n 's/^root=//p' "$LOCK_DIR/owner" | sed -n '1p')"
  [[ "$INHERITED_LOCK_PID" == "$inherited_owner_pid" ]] \
    || fail "Inherited PackScout maintenance lock PID does not match its owner metadata."
  [[ "$PPID" == "$INHERITED_LOCK_PID" ]] \
    || fail "Inherited PackScout maintenance lock owner is not restart's direct parent."
  [[ "$inherited_owner_root" == "$ROOT" ]] \
    || fail "Inherited PackScout maintenance lock belongs to a different checkout."
elif ! mkdir "$LOCK_DIR" >/dev/null 2>&1; then
  lock_pid="unknown"
  if [[ -f "$LOCK_DIR/owner" ]]; then
    discovered_pid="$(sed -n 's/^pid=//p' "$LOCK_DIR/owner" | sed -n '1p')"
    case "$discovered_pid" in
      ''|*[!0-9]*) ;;
      *) lock_pid="$discovered_pid" ;;
    esac
  fi
  fail "Another PackScout maintenance operation is already in progress for this user (pid: $lock_pid)."
else
  LOCK_HELD=true
  printf 'pid=%s\nroot=%s\n' "$$" "$ROOT" > "$LOCK_DIR/owner"
  chmod 600 "$LOCK_DIR/owner"
fi

case " $targets " in
  *" admin "*|*" worker "*)
    [[ -f "$ROOT/.env" ]] || fail "Selected admin/worker services require the ignored root .env file."
    ;;
esac
case " $targets " in
  *" frontend "*)
    if [[ "$FRONTEND_MODE" != "standard" ]]; then
      [[ -f "$ROOT/.env.local" ]] || fail "Frontend mode $FRONTEND_MODE requires the ignored root .env.local file."
    fi
    ;;
esac

HOME_DIR="${HOME:?HOME is required}"
AGENTS_DIR="$HOME_DIR/Library/LaunchAgents"
LOG_DIR="$HOME_DIR/Library/Logs/PackScout"
NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NPM_BIN_DIR="$(dirname "$NPM_BIN")"
NODE_BIN_DIR="$(dirname "$NODE_BIN")"
PATH_VALUE="$NPM_BIN_DIR"
if [[ "$NODE_BIN_DIR" != "$NPM_BIN_DIR" ]]; then
  PATH_VALUE="$PATH_VALUE:$NODE_BIN_DIR"
fi
PATH_VALUE="$PATH_VALUE:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$AGENTS_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR"

label_for() {
  echo "dev.packscout.$1"
}

plist_for() {
  echo "$AGENTS_DIR/$(label_for "$1").plist"
}

log_for() {
  echo "$LOG_DIR/$1.log"
}

command_for() {
  case "$1" in
    frontend)
      case "$FRONTEND_MODE" in
        standard) echo "dev:frontend" ;;
        mock) echo "dev:frontend:mock:local" ;;
        mock-heat) echo "dev:frontend:mock-heat:local" ;;
      esac
      ;;
    admin) echo "dev:admin" ;;
    worker) echo "start:worker:local" ;;
  esac
}

write_plist() {
  service="$1"
  output_path="$2"
  service_label="$(label_for "$service")"
  npm_script="$(command_for "$service")"
  service_log="$(log_for "$service")"
  "$NODE_BIN" - "$output_path" "$service_label" "$NPM_BIN" "$npm_script" "$ROOT" "$HOME_DIR" "$PATH_VALUE" "$service_log" "$service" <<'NODE'
const fs = require("node:fs");
const [output, label, npm, npmScript, root, home, pathValue, log, service] = process.argv.slice(2);
const escapeXml = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");
const environment = {
  HOME: home,
  PATH: pathValue,
  NODE_ENV: "development",
  ...(service === "frontend" ? {
    PACKSCOUT_FRONTEND_HOST: "127.0.0.1",
    PACKSCOUT_FRONTEND_PORT: "5100",
  } : {}),
  ...(service === "admin" ? {
    PACKSCOUT_ADMIN_HOST: "127.0.0.1",
    PACKSCOUT_ADMIN_PORT: "5101",
    PACKSCOUT_ADMIN_HMR_PORT: "5102",
  } : {}),
};
const environmentXml = Object.entries(environment)
  .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
  .join("\n");
const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(npm)}</string>
        <string>run</string>
        <string>${escapeXml(npmScript)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>WorkingDirectory</key>
    <string>${escapeXml(root)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>20</integer>
    <key>Umask</key>
    <integer>63</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
fs.writeFileSync(output, document, { encoding: "utf8", mode: 0o600 });
NODE
}

loaded_job_details() {
  local service="$1"
  launchctl print "gui/$UID_NUMBER/$(label_for "$service")" 2>/dev/null
}

job_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*$key = //p" | sed -n '1p'
}

assert_service_ownership() {
  local service="$1"
  local plist
  local plist_root
  local details
  local loaded_root
  plist="$(plist_for "$service")"

  if [[ -L "$plist" ]]; then
    fail "Refusing to replace symlinked launchd plist for $service: $plist"
  fi
  if [[ -e "$plist" ]]; then
    plist_root="$(plutil -extract WorkingDirectory raw -o - "$plist" 2>/dev/null)" \
      || fail "Cannot verify the WorkingDirectory in existing $service plist: $plist"
    [[ "$plist_root" == "$ROOT" ]] \
      || fail "Existing $service plist belongs to a different checkout: $plist_root"
  fi

  if details="$(loaded_job_details "$service")"; then
    [[ -f "$plist" ]] \
      || fail "Loaded launchd job $(label_for "$service") has no plist to support a safe rollback."
    loaded_root="$(printf '%s\n' "$details" | job_value 'working directory')"
    [[ -n "$loaded_root" ]] \
      || fail "Cannot verify the WorkingDirectory of loaded launchd job $(label_for "$service")."
    [[ "$loaded_root" == "$ROOT" ]] \
      || fail "Loaded launchd job $(label_for "$service") belongs to a different checkout: $loaded_root"
  fi
}

pid_belongs_to_job() {
  local candidate_pid="$1"
  local job_pid="$2"
  local current_pid="$candidate_pid"
  local parent_pid
  local depth=0

  while [[ "$depth" -lt 32 ]]; do
    [[ "$current_pid" == "$job_pid" ]] && return 0
    case "$current_pid" in
      ''|*[!0-9]*|0|1) return 1 ;;
    esac
    parent_pid="$(ps -p "$current_pid" -o ppid= 2>/dev/null)" || return 1
    parent_pid="$(printf '%s' "$parent_pid" | sed 's/[[:space:]]//g')"
    [[ "$parent_pid" != "$current_pid" ]] || return 1
    current_pid="$parent_pid"
    depth=$((depth + 1))
  done
  return 1
}

listening_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
}

preflight_port() {
  local service="$1"
  local port="$2"
  local listeners
  local details
  local job_pid
  local listener_pid
  listeners="$(listening_pids "$port")"
  [[ -n "$listeners" ]] || return 0

  if ! details="$(loaded_job_details "$service")"; then
    fail "$service cannot restart because port $port is owned by a foreign process; no services were stopped."
  fi
  job_pid="$(printf '%s\n' "$details" | job_value pid)"
  case "$job_pid" in
    ''|*[!0-9]*|0) fail "Cannot verify the process for loaded launchd job $(label_for "$service")." ;;
  esac
  for listener_pid in $listeners; do
    case "$listener_pid" in
      ''|*[!0-9]*) fail "Cannot identify the process listening on port $port." ;;
    esac
    pid_belongs_to_job "$listener_pid" "$job_pid" \
      || fail "$service cannot restart because port $port is owned by a foreign process; no services were stopped."
  done
}

verify_live_port_ownership() {
  local service="$1"
  local port="$2"
  local listeners
  local details
  local job_pid
  local listener_pid
  listeners="$(listening_pids "$port")"
  [[ -n "$listeners" ]] || {
    echo "ERROR: $service returned healthy but no listener was found on port $port." >&2
    return 1
  }
  details="$(loaded_job_details "$service")" || {
    echo "ERROR: $service returned healthy without a loaded $(label_for "$service") launchd job." >&2
    return 1
  }
  job_pid="$(printf '%s\n' "$details" | job_value pid)"
  case "$job_pid" in
    ''|*[!0-9]*|0)
      echo "ERROR: Cannot verify the current launchd PID for healthy $service." >&2
      return 1
      ;;
  esac
  for listener_pid in $listeners; do
    case "$listener_pid" in
      ''|*[!0-9]*)
        echo "ERROR: Cannot identify the $service listener on port $port." >&2
        return 1
        ;;
    esac
    if ! pid_belongs_to_job "$listener_pid" "$job_pid"; then
      echo "ERROR: $service health on port $port was served by a process outside its current launchd job." >&2
      return 1
    fi
  done
}

port_is_free() {
  [[ -z "$(listening_pids "$1")" ]]
}

wait_for_job_unloaded() {
  local service="$1"
  local attempt=1
  while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
    if ! loaded_job_details "$service" >/dev/null; then return 0; fi
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "ERROR: launchd job $(label_for "$service") remained loaded after bootout." >&2
  return 1
}

stop_service() {
  local service="$1"
  local label
  local details
  local loaded_root
  STOP_SERVICE_WAS_LOADED=false
  STOP_SERVICE_BOOTOUT_SUCCEEDED=false
  label="$(label_for "$service")"
  if ! details="$(loaded_job_details "$service")"; then
    echo "  $service was not running"
    return 0
  fi
  STOP_SERVICE_WAS_LOADED=true

  loaded_root="$(printf '%s\n' "$details" | job_value 'working directory')"
  [[ "$loaded_root" == "$ROOT" ]] || {
    echo "ERROR: Refusing to stop $label because it no longer belongs to this checkout." >&2
    return 1
  }
  if ! launchctl bootout "gui/$UID_NUMBER/$label" >/dev/null 2>&1; then
    echo "ERROR: launchd failed to boot out loaded $service job; it was not treated as stopped." >&2
    return 1
  fi
  STOP_SERVICE_BOOTOUT_SUCCEEDED=true
  wait_for_job_unloaded "$service" || return 1
  echo "  stopped $service"
}

wait_for_free_port() {
  local service="$1"
  local port="$2"
  local attempt=1
  while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
    if port_is_free "$port"; then return 0; fi
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "ERROR: $service cannot start because port $port remains occupied after its launchd job stopped; no process was killed." >&2
  return 1
}

health_matches() {
  url="$1"
  expected_service="$2"
  expected_framework="$3"
  payload="$(curl --silent --show-error --fail --max-time 2 "$url" 2>/dev/null)" || return 1
  printf '%s' "$payload" | "$NODE_BIN" -e '
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(text);
    const serviceMatches = value?.ok === true && value?.service === process.argv[1];
    const frameworkMatches = process.argv[2] === "" || value?.framework === process.argv[2];
    process.exit(serviceMatches && frameworkMatches ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
' "$expected_service" "$expected_framework"
}

wait_for_health() {
  service="$1"
  url="$2"
  expected_service="$3"
  expected_framework="$4"
  attempt=1
  while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
    if health_matches "$url" "$expected_service" "$expected_framework"; then
      echo "  ready $service at $url"
      return 0
    fi
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "ERROR: $service did not return its expected health contract at $url. See $(log_for "$service")." >&2
  return 1
}

worker_is_running() {
  local details
  local state
  local pid
  details="$(loaded_job_details worker)" || return 1
  state="$(printf '%s\n' "$details" | job_value state)"
  pid="$(printf '%s\n' "$details" | job_value pid)"
  [[ "$state" == "running" ]] || return 1
  case "$pid" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

rollback_stopped_services() {
  local service
  local plist
  local details
  local loaded_root
  local rollback_failed=false
  [[ -n "$stopped_services" ]] || return 0

  echo "Restoring services stopped earlier in this failed restart..." >&2
  for service in $stopped_services; do
    plist="$(plist_for "$service")"
    if details="$(loaded_job_details "$service")"; then
      loaded_root="$(printf '%s\n' "$details" | job_value 'working directory')"
      if [[ "$loaded_root" != "$ROOT" ]]; then
        echo "ERROR: rollback found $service loaded from an unexpected WorkingDirectory." >&2
        rollback_failed=true
        continue
      fi
    else
      if ! launchctl bootstrap "gui/$UID_NUMBER" "$plist" >/dev/null 2>&1; then
        echo "ERROR: rollback could not restore $service from $plist." >&2
        rollback_failed=true
        continue
      fi
      if ! details="$(loaded_job_details "$service")"; then
        echo "ERROR: rollback bootstrapped $service but its launchd job is not loaded." >&2
        rollback_failed=true
        continue
      fi
      loaded_root="$(printf '%s\n' "$details" | job_value 'working directory')"
      if [[ "$loaded_root" != "$ROOT" ]]; then
        echo "ERROR: rollback restored $service with an unexpected WorkingDirectory." >&2
        rollback_failed=true
        continue
      fi
    fi
    case "$service" in
      frontend)
        if ! wait_for_health frontend "http://127.0.0.1:5100/api/health" "packscout-frontend" "next" \
          || ! verify_live_port_ownership frontend 5100; then
          echo "ERROR: rollback loaded frontend but could not verify its health and listener ownership." >&2
          rollback_failed=true
          continue
        fi
        ;;
      admin)
        if ! wait_for_health admin "http://127.0.0.1:5101/api/health" "packscout-admin" "" \
          || ! verify_live_port_ownership admin 5101 \
          || ! verify_live_port_ownership admin 5102; then
          echo "ERROR: rollback loaded admin but could not verify its health and listener ownership." >&2
          rollback_failed=true
          continue
        fi
        ;;
      worker)
        if ! wait_for_worker; then
          echo "ERROR: rollback loaded worker but it did not remain running." >&2
          rollback_failed=true
          continue
        fi
        ;;
    esac
    echo "  restored $service" >&2
  done
  [[ "$rollback_failed" == false ]]
}

fail_with_stop_rollback() {
  local message="$1"
  [[ -n "$stopped_services" ]] || fail "$message"
  if ! rollback_stopped_services; then
    fail "$message Rollback was incomplete; inspect launchd state before retrying."
  fi
  fail "$message Previously running services were restored."
}

wait_for_worker() {
  stable=0
  attempt=1
  while [[ "$attempt" -le "$MAX_ATTEMPTS" ]]; do
    if worker_is_running; then
      stable=$((stable + 1))
      if [[ "$stable" -ge "$WORKER_STABILITY_POLLS" ]]; then
        echo "  running worker (process liveness only; no health endpoint)"
        return 0
      fi
    else
      stable=0
    fi
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
  done
  echo "ERROR: worker did not remain running under launchd. See $(log_for worker)." >&2
  return 1
}

for service in $targets; do
  assert_service_ownership "$service"
done

# Validate every selected port before booting out any job. A listener is safe
# only when it is the selected launchd job (or one of that job's descendants).
case " $targets " in
  *" frontend "*) preflight_port frontend 5100 ;;
esac
case " $targets " in
  *" admin "*)
    preflight_port admin 5101
    preflight_port admin 5102
    ;;
esac

echo "Stopping selected PackScout services..."
stopped_services=""
for service in $targets; do
  if ! stop_service "$service"; then
    if [[ "$STOP_SERVICE_BOOTOUT_SUCCEEDED" == true ]]; then
      stopped_services="${stopped_services}${stopped_services:+ }$service"
    fi
    fail_with_stop_rollback "Selected PackScout services were not stopped safely."
  fi
  if [[ "$STOP_SERVICE_WAS_LOADED" == true ]]; then
    stopped_services="${stopped_services}${stopped_services:+ }$service"
  fi
done

port_failure=false
case " $targets " in
  *" frontend "*) wait_for_free_port frontend 5100 || port_failure=true ;;
esac
case " $targets " in
  *" admin "*)
    wait_for_free_port admin 5101 || port_failure=true
    wait_for_free_port admin-hmr 5102 || port_failure=true
    ;;
esac
if [[ "$port_failure" != false ]]; then
  fail_with_stop_rollback "Selected service ports were not released; no processes were killed."
fi

if [[ "$CLEAN" == true ]]; then
  case " $targets " in
    *" frontend "*)
      echo "Cleaning PackScout frontend build caches..."
      rm -rf "$ROOT/apps/frontend/.next-dev" "$ROOT/apps/frontend/.next-build"
      ;;
  esac
fi

echo "Installing and starting selected PackScout services..."
start_failure=false
failed_services=""
for service in $targets; do
  plist="$(plist_for "$service")"
  temporary_plist="$(mktemp "$AGENTS_DIR/.dev.packscout.$service.XXXXXX")"
  write_plist "$service" "$temporary_plist"
  if ! plutil -lint "$temporary_plist" >/dev/null; then
    rm -f "$temporary_plist"
    echo "ERROR: generated plist validation failed for $service." >&2
    start_failure=true
    continue
  fi
  install -m 600 "$temporary_plist" "$plist"
  rm -f "$temporary_plist"
  label="$(label_for "$service")"
  launchctl enable "gui/$UID_NUMBER/$label" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$UID_NUMBER" "$plist" >/dev/null 2>&1; then
    echo "  started $service"
  else
    echo "ERROR: launchd failed to bootstrap $service. See $(log_for "$service")." >&2
    if loaded_job_details "$service" >/dev/null; then
      stop_service "$service" || true
    fi
    failed_services="${failed_services}${failed_services:+ }$service"
    start_failure=true
  fi
done

readiness_failure=false
for service in $targets; do
  label="$(label_for "$service")"
  case " $failed_services " in
    *" $service "*) continue ;;
  esac
  service_failed=false
  case "$service" in
    frontend)
      if wait_for_health frontend "http://127.0.0.1:5100/api/health" "packscout-frontend" "next"; then
        verify_live_port_ownership frontend 5100 || service_failed=true
      else
        service_failed=true
      fi
      ;;
    admin)
      if wait_for_health admin "http://127.0.0.1:5101/api/health" "packscout-admin" ""; then
        if ! verify_live_port_ownership admin 5101; then
          service_failed=true
        elif ! verify_live_port_ownership admin 5102; then
          service_failed=true
        fi
      else
        service_failed=true
      fi
      ;;
    worker)
      wait_for_worker || service_failed=true
      ;;
  esac
  if [[ "$service_failed" == true ]]; then
    readiness_failure=true
    if ! stop_service "$service"; then
      echo "ERROR: Failed to unload unhealthy $service job." >&2
    fi
  fi
done

if [[ "$start_failure" == true || "$readiness_failure" == true ]]; then
  fail "One or more PackScout services failed to start or become ready."
fi

echo "PackScout services restarted successfully."
