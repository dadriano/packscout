#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
REMOTE="${PACKSCOUT_UPDATE_REMOTE:-origin}"
BRANCH="${PACKSCOUT_UPDATE_BRANCH:-main}"
REMOTE_REF="refs/remotes/${REMOTE}/${BRANCH}"
DRY_RUN=false
RESTART_ARGS=()
UPDATE_LOCK_DIR=""
UPDATE_LOCK_HELD=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/local/update-main.sh [options] [service ...]
  npm run workspace:update:main:local -- [options] [service ...]

Safely fast-forward PackScout's clean primary checkout, run npm ci, and restart
the selected launchd-managed local services. The update target defaults to
origin/main. With no service names, the frontend, admin, and worker restart.

Update options:
  --dry-run                       Validate local preconditions and print the
                                  planned commands without fetching or changing
                                  Git refs, workspace files, dependencies, or
                                  services
  --help, -h                      Show this help

Services:
  frontend                        Restart the frontend service
  admin                           Restart the admin service
  worker                          Restart the worker service

Options forwarded to restart.sh:
  --clean                         Clear only selected frontend build caches
  --frontend-mode <mode>          standard | mock | mock-heat
  --frontend-mode=<mode>          Equivalent assignment form

Update sequence:
  1. Require the primary checkout and configured target branch.
  2. Acquire the shared PackScout maintenance lock and require a clean tree.
  3. Fetch the configured remote branch and require a fast-forward-only update.
  4. Refuse incoming paths that would replace ignored or untracked local data.
  5. Merge with --ff-only, run npm ci, then invoke restart.sh.

Safety:
  - --force is intentionally unsupported; the script never checks out, resets,
    cleans, or discards local work.
  - Commit, stash, or remove every tracked and untracked workspace change first,
    including changes under .tasks or output.
  - Linked worktrees, detached/wrong branches, local-ahead history, divergence,
    and ignored-path collisions are refused.
  - Ignored environment files are preserved. If an incoming tracked path would
    collide with one, the update stops before merging.
  - If npm ci or restart fails after a successful merge, the new commit remains
    checked out; fix the reported problem and rerun rather than resetting.

Explicit environment overrides:
  PACKSCOUT_UPDATE_REMOTE          Git remote (default: origin)
  PACKSCOUT_UPDATE_BRANCH          Local and remote branch (default: main)

Examples:
  ./scripts/local/update-main.sh --dry-run
  ./scripts/local/update-main.sh
  ./scripts/local/update-main.sh frontend
  ./scripts/local/update-main.sh --clean frontend admin
  ./scripts/local/update-main.sh --frontend-mode mock-heat frontend worker
  PACKSCOUT_UPDATE_REMOTE=upstream ./scripts/local/update-main.sh --dry-run

Exit status:
  0  Help/dry-run completed, or update, install, and restart all succeeded.
  1+ Invalid input, unsafe repository state, Git/npm failure, or restart failure.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '→'
  for command_arg in "$@"; do
    printf ' %q' "$command_arg"
  done
  printf '\n'
}

run() {
  print_command "$@"
  "$@"
}

append_restart_arg() {
  RESTART_ARGS[${#RESTART_ARGS[@]}]="$1"
}

parse_arguments() {
  local mode

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=true
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      --force)
        fail "--force is not supported; the updater never discards local work."
        ;;
      --clean)
        append_restart_arg "$1"
        shift
        ;;
      --frontend-mode)
        [[ $# -ge 2 ]] || fail "--frontend-mode requires standard, mock, or mock-heat."
        mode="$2"
        case "$mode" in
          standard|mock|mock-heat) ;;
          *) fail "Unknown frontend mode '$mode' (expected standard, mock, or mock-heat)." ;;
        esac
        append_restart_arg --frontend-mode
        append_restart_arg "$mode"
        shift 2
        ;;
      --frontend-mode=*)
        mode="${1#*=}"
        case "$mode" in
          standard|mock|mock-heat) ;;
          *) fail "Unknown frontend mode '$mode' (expected standard, mock, or mock-heat)." ;;
        esac
        append_restart_arg --frontend-mode
        append_restart_arg "$mode"
        shift
        ;;
      frontend|admin|worker)
        append_restart_arg "$1"
        shift
        ;;
      --*)
        fail "Unknown option '$1'."
        ;;
      *)
        fail "Unknown service '$1' (expected frontend, admin, or worker)."
        ;;
    esac
  done
}

ensure_primary_checkout() {
  local repo_top

  [[ -d "$ROOT/.git" ]] || fail "Run this updater from the primary PackScout checkout; linked worktrees are not supported."
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "PackScout root is not a Git checkout: $ROOT"
  repo_top="$(cd "$(git -C "$ROOT" rev-parse --show-toplevel)" && pwd -P)"
  [[ "$repo_top" == "$ROOT" ]] || fail "Script root '$ROOT' does not match Git root '$repo_top'."
}

ensure_safe_target() {
  local current_branch

  case "$REMOTE" in
    ""|-*|*[!A-Za-z0-9._/-]*) fail "Invalid update remote '$REMOTE'." ;;
  esac
  case "$BRANCH" in
    ""|-*) fail "Invalid update branch '$BRANCH'." ;;
  esac
  git -C "$ROOT" check-ref-format "refs/heads/$BRANCH" >/dev/null 2>&1 || fail "Invalid update branch '$BRANCH'."
  git -C "$ROOT" remote get-url "$REMOTE" >/dev/null 2>&1 || fail "Git remote '$REMOTE' is not configured."

  if ! current_branch="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD)"; then
    fail "The primary checkout has a detached HEAD; switch to '$BRANCH' first."
  fi
  [[ "$current_branch" == "$BRANCH" ]] || fail "Current branch is '$current_branch'; switch to '$BRANCH' before updating."
}

release_update_lock() {
  local exit_status=$?

  trap - EXIT HUP INT TERM
  if [[ "$UPDATE_LOCK_HELD" == true ]]; then
    rm -f "$UPDATE_LOCK_DIR/owner"
    if ! rmdir "$UPDATE_LOCK_DIR"; then
      printf 'Warning: unable to release maintenance lock: %s\n' "$UPDATE_LOCK_DIR" >&2
    fi
    UPDATE_LOCK_HELD=false
  fi

  exit "$exit_status"
}

acquire_update_lock() {
  local uid_number
  uid_number="$(id -u)"
  UPDATE_LOCK_DIR="${TMPDIR:-/tmp}/dev.packscout.maintenance.$uid_number.lock"

  if ! mkdir "$UPDATE_LOCK_DIR" 2>/dev/null; then
    fail "Another PackScout maintenance operation is already running (lock: $UPDATE_LOCK_DIR)."
  fi

  UPDATE_LOCK_HELD=true
  printf 'pid=%s\nroot=%s\n' "$$" "$ROOT" > "$UPDATE_LOCK_DIR/owner"
  chmod 600 "$UPDATE_LOCK_DIR/owner"
  trap release_update_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

ensure_clean_workspace() {
  local status

  status="$(git -C "$ROOT" status --porcelain --untracked-files=all)"
  if [[ -n "$status" ]]; then
    printf 'Error: workspace must be completely clean before updating.\n\n%s\n' "$status" >&2
    exit 1
  fi
}

ensure_fast_forward() {
  git -C "$ROOT" rev-parse --verify --quiet "${REMOTE_REF}^{commit}" >/dev/null || \
    fail "Fetched branch '${REMOTE}/${BRANCH}' did not create '$REMOTE_REF'."

  if git -C "$ROOT" merge-base --is-ancestor HEAD "$REMOTE_REF"; then
    return 0
  fi

  if git -C "$ROOT" merge-base --is-ancestor "$REMOTE_REF" HEAD; then
    fail "Local '$BRANCH' is ahead of '${REMOTE}/${BRANCH}'; refusing to rewrite or discard commits."
  fi

  fail "Local '$BRANCH' has diverged from '${REMOTE}/${BRANCH}'; resolve it manually."
}

path_is_tracked_at_head() {
  git -C "$ROOT" cat-file -e "HEAD:$1" >/dev/null 2>&1
}

object_type_at_ref() {
  git -C "$ROOT" cat-file -t "$1:$2" 2>/dev/null || true
}

ensure_local_target_available() {
  local target_path="$1"
  local local_path="$ROOT/$target_path"
  local parent_path="$target_path"
  local local_parent
  local head_type
  local incoming_type

  if path_is_tracked_at_head "$target_path"; then
    head_type="$(object_type_at_ref HEAD "$target_path")"
    incoming_type="$(object_type_at_ref "$REMOTE_REF" "$target_path")"
    if [[ -n "$incoming_type" && "$head_type" != "$incoming_type" && ( -e "$local_path" || -L "$local_path" ) ]]; then
      fail "Incoming '${REMOTE}/${BRANCH}' changes '$target_path' from Git object type '$head_type' to '$incoming_type'; refusing to replace the existing local path automatically."
    fi
    return 0
  fi

  if [[ -e "$local_path" || -L "$local_path" ]]; then
    fail "Incoming '${REMOTE}/${BRANCH}' path '$target_path' collides with an untracked or ignored local path; move it manually before updating."
  fi

  while [[ "$parent_path" == */* ]]; do
    parent_path="${parent_path%/*}"
    [[ -n "$parent_path" ]] || break

    if path_is_tracked_at_head "$parent_path"; then
      continue
    fi

    local_parent="$ROOT/$parent_path"
    if [[ -L "$local_parent" || ( -e "$local_parent" && ! -d "$local_parent" ) ]]; then
      fail "Incoming '${REMOTE}/${BRANCH}' path '$target_path' is blocked by untracked or ignored local parent '$parent_path'; move it manually before updating."
    fi
  done
}

ensure_no_path_collisions() {
  local status
  local source_path
  local target_path

  git -C "$ROOT" diff --name-status -z --find-renames HEAD "$REMOTE_REF" |
    while IFS= read -r -d '' status; do
      case "$status" in
        R*|C*)
          IFS= read -r -d '' source_path || fail "Unable to inspect incoming renamed paths."
          IFS= read -r -d '' target_path || fail "Unable to inspect incoming renamed paths."
          ;;
        D*)
          IFS= read -r -d '' source_path || fail "Unable to inspect incoming deleted paths."
          continue
          ;;
        *)
          IFS= read -r -d '' target_path || fail "Unable to inspect incoming paths."
          ;;
      esac

      ensure_local_target_available "$target_path"
    done
}

restart_command() {
  local command=("$ROOT/scripts/local/restart.sh")
  local restart_arg

  for restart_arg in "${RESTART_ARGS[@]}"; do
    command[${#command[@]}]="$restart_arg"
  done

  if [[ "$DRY_RUN" == true ]]; then
    print_command "${command[@]}"
  else
    print_command "${command[@]}"
    PACKSCOUT_MAINTENANCE_LOCK_OWNER_PID="$$" "${command[@]}"
  fi
}

update_checkout() {
  if [[ "$DRY_RUN" == true ]]; then
    print_command git -C "$ROOT" fetch "$REMOTE" "$BRANCH"
    printf '→ verify HEAD can fast-forward to %s\n' "$REMOTE_REF"
    print_command git -C "$ROOT" merge --ff-only "$REMOTE_REF"
    print_command npm ci
    restart_command
    printf '\nDry run complete; no files, refs, dependencies, or services were changed.\n'
    return 0
  fi

  run git -C "$ROOT" fetch "$REMOTE" "$BRANCH"
  ensure_fast_forward
  ensure_no_path_collisions
  ensure_clean_workspace
  ensure_no_path_collisions
  run git -C "$ROOT" merge --ff-only "$REMOTE_REF"
  (
    cd "$ROOT"
    run npm ci
  )
  restart_command

  printf '\nPackScout updated successfully at %s.\n' "$(git -C "$ROOT" rev-parse --short HEAD)"
}

main() {
  parse_arguments "$@"
  ensure_primary_checkout
  ensure_safe_target
  cd "$ROOT"
  acquire_update_lock
  ensure_clean_workspace

  printf 'PackScout checkout: %s\n' "$ROOT"
  printf 'Update target: %s/%s\n' "$REMOTE" "$BRANCH"
  update_checkout
}

main "$@"
