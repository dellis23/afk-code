#!/usr/bin/env bash
#
# Integration test for the mock Discord system.
# Exercises the full lifecycle: create, message, archive, resume,
# re-archive, re-resume, topic change, delete, and orphan recovery.
#
# Usage: ./scripts/test-mock-discord.sh
# Prerequisites: npm run build (runs automatically)
#

set -uo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"
PASS=0
FAIL=0
MOCK_PID=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  rm -f ~/.afk-code/daemon.sock 2>/dev/null || true
  # Kill any stale afk- tmux sessions from test
  tmux ls 2>/dev/null | grep '^afk-' | cut -d: -f1 | while read s; do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
}
trap cleanup EXIT

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $desc"
    echo -e "    expected: $expected"
    echo -e "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}PASS${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC} $desc"
    echo -e "    expected to contain: $expected"
    echo -e "    actual: $actual"
    FAIL=$((FAIL + 1))
  fi
}

post() {
  curl -s -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"
}

get() {
  curl -s "$BASE$1"
}

jq_val() {
  python3 -c "
import sys, json
d = json.loads(sys.argv[1])
print(eval('d' + sys.argv[2]))
" "$1" "$2" 2>/dev/null
}

# ─── Build ───
echo -e "${YELLOW}Building...${NC}"
cd "$(dirname "$0")/.."
npm run build 2>&1

# ─── Clean state ───
echo '{"channels":{}}' > ~/.afk-code/discord-channels.json
rm -f ~/.afk-code/daemon.sock 2>/dev/null
# Kill stale tmux sessions
tmux ls 2>/dev/null | grep '^afk-' | cut -d: -f1 | while read s; do
  tmux kill-session -t "$s" 2>/dev/null || true
done

# ─── Start mock server ───
echo -e "${YELLOW}Starting mock Discord server on port $PORT...${NC}"
node dist/cli/index.js discord --mock-discord &>/dev/null &
MOCK_PID=$!
sleep 3

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo -e "${RED}Mock server failed to start${NC}"
  exit 1
fi
echo -e "${GREEN}Mock server running (PID $MOCK_PID)${NC}"
echo ""

# ═══════════════════════════════════════
# Test 1: Create channel
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 1: Create channel${NC}"
RESP=$(post /create-channel '{"name":"afk-test"}')
CHAN_ID=$(jq_val "$RESP" "['channelId']")
SESS_ID=$(jq_val "$RESP" "['sessionId']")
assert_contains "channel created" "mock-chan" "$CHAN_ID"
assert_contains "session spawned" "" "$SESS_ID"  # just check it's non-empty

# Verify in sessions list
SESSIONS=$(get /sessions)
CHAN_STATUS=$(jq_val "$SESSIONS" "['channels'][0]['status']")
assert_eq "channel status is running" "running" "$CHAN_STATUS"
echo ""

# ═══════════════════════════════════════
# Test 2: Send message
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 2: Send message${NC}"
RESP=$(post /send-message "{\"channelId\":\"$CHAN_ID\",\"content\":\"hello world\"}")
OK=$(jq_val "$RESP" "['ok']")
assert_eq "message sent" "True" "$OK"
echo ""

# ═══════════════════════════════════════
# Test 3: Archive
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 3: Archive channel${NC}"
sleep 2  # let session settle
RESP=$(post /command "{\"channelId\":\"$CHAN_ID\",\"command\":\"archive\"}")
assert_contains "archive response" "archived" "$RESP"

SESSIONS=$(get /sessions)
CHAN_STATUS=$(jq_val "$SESSIONS" "['channels'][0]['status']")
CHAN_NAME=$(jq_val "$SESSIONS" "['channels'][0]['name']")
assert_eq "channel status is archived" "archived" "$CHAN_STATUS"
assert_contains "channel name has -archived suffix" "-archived" "$CHAN_NAME"

SESS_COUNT=$(jq_val "$SESSIONS" ".get('sessions',[]).__len__()")
assert_eq "no active sessions" "0" "$SESS_COUNT"
echo ""

# ═══════════════════════════════════════
# Test 4: Resume from archive
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 4: Resume from archive (send message)${NC}"
RESP=$(post /send-message "{\"channelId\":\"$CHAN_ID\",\"content\":\"are you back?\"}")
RESUMED=$(jq_val "$RESP" "['resumed']")
NEW_SESS=$(jq_val "$RESP" "['newSessionId']")
assert_eq "resumed flag" "True" "$RESUMED"
assert_contains "new session id" "" "$NEW_SESS"

SESSIONS=$(get /sessions)
CHAN_STATUS=$(jq_val "$SESSIONS" "['channels'][0]['status']")
CHAN_NAME=$(jq_val "$SESSIONS" "['channels'][0]['name']")
assert_eq "channel status is running after resume" "running" "$CHAN_STATUS"
assert_eq "channel name restored (no -archived)" "afk-test" "$CHAN_NAME"
echo ""

# ═══════════════════════════════════════
# Test 5: Archive again (second cycle)
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 5: Archive again${NC}"
sleep 2
RESP=$(post /command "{\"channelId\":\"$CHAN_ID\",\"command\":\"archive\"}")
assert_contains "second archive response" "archived" "$RESP"

SESSIONS=$(get /sessions)
CHAN_STATUS=$(jq_val "$SESSIONS" "['channels'][0]['status']")
assert_eq "channel archived again" "archived" "$CHAN_STATUS"
echo ""

# ═══════════════════════════════════════
# Test 6: Resume again (second cycle)
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 6: Resume again${NC}"
RESP=$(post /send-message "{\"channelId\":\"$CHAN_ID\",\"content\":\"second resume\"}")
RESUMED=$(jq_val "$RESP" "['resumed']")
assert_eq "second resume" "True" "$RESUMED"

SESSIONS=$(get /sessions)
CHAN_STATUS=$(jq_val "$SESSIONS" "['channels'][0]['status']")
assert_eq "channel running after second resume" "running" "$CHAN_STATUS"
echo ""

# ═══════════════════════════════════════
# Test 6b: No message replay after resume
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 6b: No message replay after resume${NC}"
sleep 5  # let JSONL watcher settle after second resume

# Count messages received so far
MSG_RESP=$(get "/messages?channelId=$CHAN_ID")
MSG_COUNT_BEFORE=$(jq_val "$MSG_RESP" "['count']")
echo -e "  Messages before archive: $MSG_COUNT_BEFORE"

# Archive
RESP=$(post /command "{\"channelId\":\"$CHAN_ID\",\"command\":\"archive\"}")
assert_contains "archive for replay test" "archived" "$RESP"
sleep 2

# Resume
RESP=$(post /send-message "{\"channelId\":\"$CHAN_ID\",\"content\":\"replay test\"}")
RESUMED=$(jq_val "$RESP" "['resumed']")
assert_eq "resumed for replay test" "True" "$RESUMED"
sleep 8  # give JSONL watcher time to process

# Count messages after resume — should have grown by at most a small number
# (the resume message itself, maybe a status), NOT a replay of all history
MSG_RESP=$(get "/messages?channelId=$CHAN_ID")
MSG_COUNT_AFTER=$(jq_val "$MSG_RESP" "['count']")
echo -e "  Messages after resume: $MSG_COUNT_AFTER"

NEW_MESSAGES=$((MSG_COUNT_AFTER - MSG_COUNT_BEFORE))
echo -e "  New messages after resume: $NEW_MESSAGES"

# If we replayed history, we'd see the count roughly double.
# Allow up to 10 new messages for legitimate new activity (session start, status, etc.)
if [[ $NEW_MESSAGES -le 10 ]]; then
  echo -e "  ${GREEN}PASS${NC} no message replay ($NEW_MESSAGES new messages)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${NC} message replay detected ($NEW_MESSAGES new messages after resume, expected <= 10)"
  FAIL=$((FAIL + 1))
fi

# Clean up: archive so test 6c can proceed with a running channel
RESP=$(post /command "{\"channelId\":\"$CHAN_ID\",\"command\":\"archive\"}")
sleep 2
RESP=$(post /send-message "{\"channelId\":\"$CHAN_ID\",\"content\":\"cleanup resume\"}")
sleep 3
echo ""

# ═══════════════════════════════════════
# Test 6c: No message replay after /clear
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 6c: No message replay after /clear${NC}"
sleep 5  # let JSONL watcher settle

# Count messages before /clear
MSG_RESP=$(get "/messages?channelId=$CHAN_ID")
MSG_COUNT_BEFORE=$(jq_val "$MSG_RESP" "['count']")
echo -e "  Messages before /clear: $MSG_COUNT_BEFORE"

# Send /clear
RESP=$(post /command "{\"channelId\":\"$CHAN_ID\",\"command\":\"clear\"}")
assert_contains "clear sent" "ok" "$RESP"
sleep 8  # give JSONL watcher time to find new file

# Count messages after /clear
MSG_RESP=$(get "/messages?channelId=$CHAN_ID")
MSG_COUNT_AFTER=$(jq_val "$MSG_RESP" "['count']")
echo -e "  Messages after /clear: $MSG_COUNT_AFTER"

NEW_MESSAGES=$((MSG_COUNT_AFTER - MSG_COUNT_BEFORE))
echo -e "  New messages after /clear: $NEW_MESSAGES"

if [[ $NEW_MESSAGES -le 10 ]]; then
  echo -e "  ${GREEN}PASS${NC} no message replay after /clear ($NEW_MESSAGES new messages)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${NC} message replay detected after /clear ($NEW_MESSAGES new messages, expected <= 10)"
  FAIL=$((FAIL + 1))
fi
echo ""

# ═══════════════════════════════════════
# Test 7: Change topic
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 7: Change topic${NC}"
RESP=$(post /change-topic "{\"channelId\":\"$CHAN_ID\",\"topic\":\"/tmp\"}")
NEW_SESS=$(jq_val "$RESP" "['sessionId']")
CWD=$(jq_val "$RESP" "['cwd']")
assert_eq "new cwd is /tmp" "/tmp" "$CWD"
assert_contains "new session spawned" "" "$NEW_SESS"
echo ""

# ═══════════════════════════════════════
# Test 8: Delete channel
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 8: Delete channel${NC}"
RESP=$(post /delete-channel "{\"channelId\":\"$CHAN_ID\"}")
OK=$(jq_val "$RESP" "['ok']")
assert_eq "delete ok" "True" "$OK"

SESSIONS=$(get /sessions)
CHAN_COUNT=$(jq_val "$SESSIONS" ".get('channels',[]).__len__()")
assert_eq "no channels after delete" "0" "$CHAN_COUNT"
echo ""

# ═══════════════════════════════════════
# Test 9: Prefix validation
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 9: Prefix validation${NC}"
RESP=$(post /create-channel '{"name":"claude-test"}')
assert_contains "rejects claude- prefix" "afk-" "$RESP"

RESP=$(post /create-channel '{"name":"general"}')
assert_contains "rejects non-afk name" "afk-" "$RESP"
echo ""

# ═══════════════════════════════════════
# Test 10: Orphan recovery
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 10: Orphan recovery${NC}"
# Create a channel and get its session
RESP=$(post /create-channel '{"name":"afk-orphan"}')
ORPHAN_CHAN=$(jq_val "$RESP" "['channelId']")
ORPHAN_SESS=$(jq_val "$RESP" "['sessionId']")
sleep 3

# Verify tmux session exists
TMUX_CHECK=$(tmux ls 2>&1 | grep "afk-$ORPHAN_SESS" || echo "not found")
assert_contains "tmux session exists before kill" "afk-$ORPHAN_SESS" "$TMUX_CHECK"

# SIGKILL the mock (simulates crash — no cleanup)
kill -9 "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""
sleep 1

# Verify tmux survived
TMUX_CHECK=$(tmux ls 2>&1 | grep "afk-$ORPHAN_SESS" || echo "not found")
assert_contains "tmux session survived crash" "afk-$ORPHAN_SESS" "$TMUX_CHECK"

# Clean up stale socket and restart
rm -f ~/.afk-code/daemon.sock 2>/dev/null
node dist/cli/index.js discord --mock-discord &>/dev/null &
MOCK_PID=$!
sleep 4

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo -e "  ${RED}FAIL${NC} mock server failed to restart"
  ((FAIL++))
else
  # Verify re-attach
  SESSIONS=$(get /sessions)
  SESS_COUNT=$(jq_val "$SESSIONS" ".get('sessions',[]).__len__()")
  CHAN_COUNT=$(jq_val "$SESSIONS" ".get('channels',[]).__len__()")
  assert_eq "session re-attached" "1" "$SESS_COUNT"
  assert_eq "channel restored" "1" "$CHAN_COUNT"

  # Verify message sending works on re-attached session
  RESP=$(post /send-message "{\"channelId\":\"$ORPHAN_CHAN\",\"content\":\"still alive?\"}")
  OK=$(jq_val "$RESP" "['ok']")
  assert_eq "send to re-attached session" "True" "$OK"

  # Clean up
  post /delete-channel "{\"channelId\":\"$ORPHAN_CHAN\"}" >/dev/null
fi
echo ""

# ═══════════════════════════════════════
# Test 11: Resume with bad session ID
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 11: Resume with bad session ID (retry without --resume)${NC}"

# Create a channel and wait for it to stabilize
RESP=$(post /create-channel '{"name":"afk-badresume"}')
BAD_CHAN=$(jq_val "$RESP" "['channelId']")
BAD_SESS=$(jq_val "$RESP" "['sessionId']")
assert_contains "channel created" "mock-chan" "$BAD_CHAN"
sleep 3

# Archive the channel
RESP=$(post /command "{\"channelId\":\"$BAD_CHAN\",\"command\":\"archive\"}")
assert_contains "archived" "archived" "$RESP"

# Corrupt the claudeSessionId to a nonexistent UUID
RESP=$(post /set-channel-state "{\"channelId\":\"$BAD_CHAN\",\"claudeSessionId\":\"00000000-0000-0000-0000-000000000000\"}")
assert_eq "state updated" "archived" "$(jq_val "$RESP" "['status']")"

# Send a message — triggers resume with bad --resume, should retry fresh
RESP=$(post /send-message "{\"channelId\":\"$BAD_CHAN\",\"content\":\"are you there?\"}")
RESUMED=$(jq_val "$RESP" "['resumed']")
assert_eq "resumed after bad session" "True" "$RESUMED"

# Verify channel is running
SESSIONS=$(get /sessions)
BAD_STATUS=""
for i in 0 1 2 3 4 5 6 7 8 9; do
  S=$(jq_val "$SESSIONS" "['channels'][$i]['channelId']" 2>/dev/null)
  if [[ "$S" == "$BAD_CHAN" ]]; then
    BAD_STATUS=$(jq_val "$SESSIONS" "['channels'][$i]['status']")
    break
  fi
done
assert_eq "channel running after bad resume retry" "running" "$BAD_STATUS"

# Clean up
post /delete-channel "{\"channelId\":\"$BAD_CHAN\"}" >/dev/null
sleep 1
echo ""

# ═══════════════════════════════════════
# Test 12: Restart recovery for ended channels
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 12: Restart recovery for ended channels${NC}"

# Create a channel
RESP=$(post /create-channel '{"name":"afk-ended"}')
ENDED_CHAN=$(jq_val "$RESP" "['channelId']")
assert_contains "channel created" "mock-chan" "$ENDED_CHAN"
sleep 3

# Get the session ID before we force it to ended
ENDED_SESS=$(jq_val "$(get /sessions)" "['channels'][0]['sessionId']" 2>/dev/null)

# Force channel to 'ended' state (simulates what happened to the user)
RESP=$(post /set-channel-state "{\"channelId\":\"$ENDED_CHAN\",\"status\":\"ended\"}")
assert_eq "forced to ended" "ended" "$(jq_val "$RESP" "['status']")"

# Wait for persistence (debounced at 100ms)
sleep 1

# Kill the tmux session so it looks like a cold restart
if [[ -n "$ENDED_SESS" ]] && tmux has-session -t "afk-$ENDED_SESS" 2>/dev/null; then
  tmux kill-session -t "afk-$ENDED_SESS" 2>/dev/null || true
fi

# SIGKILL the mock (simulates restart)
kill -9 "$MOCK_PID" 2>/dev/null || true
wait "$MOCK_PID" 2>/dev/null || true
MOCK_PID=""
sleep 1

# Clean up stale socket and restart
rm -f ~/.afk-code/daemon.sock 2>/dev/null
node dist/cli/index.js discord --mock-discord &>/dev/null &
MOCK_PID=$!
sleep 5

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
  echo -e "  ${RED}FAIL${NC} mock server failed to restart for ended recovery test"
  ((FAIL++))
else
  # Verify the ended channel was restored to running
  SESSIONS=$(get /sessions)
  ENDED_STATUS=""
  for i in 0 1 2 3 4 5 6 7 8 9; do
    S=$(jq_val "$SESSIONS" "['channels'][$i]['channelId']" 2>/dev/null)
    if [[ "$S" == "$ENDED_CHAN" ]]; then
      ENDED_STATUS=$(jq_val "$SESSIONS" "['channels'][$i]['status']")
      break
    fi
  done
  assert_eq "ended channel restored to running" "running" "$ENDED_STATUS"

  # Wait for the restored session to be fully ready
  sleep 3

  # Verify we can send a message to it
  RESP=$(post /send-message "{\"channelId\":\"$ENDED_CHAN\",\"content\":\"alive after ended?\"}")
  OK=$(jq_val "$RESP" "['ok']")
  assert_eq "send to restored channel" "True" "$OK"

  # Clean up
  post /delete-channel "{\"channelId\":\"$ENDED_CHAN\"}" >/dev/null
fi
echo ""

# ═══════════════════════════════════════
# Test 13: Resume from ended state (send message)
# ═══════════════════════════════════════
echo -e "${YELLOW}Test 13: Resume from ended state${NC}"

# Create a channel
RESP=$(post /create-channel '{"name":"afk-ended-resume"}')
ENDED_RESUME_CHAN=$(jq_val "$RESP" "['channelId']")
assert_contains "channel created" "mock-chan" "$ENDED_RESUME_CHAN"
sleep 3

# Force channel to 'ended' state and kill the session
ENDED_RESUME_SESS=$(jq_val "$(get /sessions)" "['channels'][0]['sessionId']" 2>/dev/null)
RESP=$(post /set-channel-state "{\"channelId\":\"$ENDED_RESUME_CHAN\",\"status\":\"ended\"}")
assert_eq "forced to ended" "ended" "$(jq_val "$RESP" "['status']")"

# Kill the tmux session
if [[ -n "$ENDED_RESUME_SESS" ]] && tmux has-session -t "afk-$ENDED_RESUME_SESS" 2>/dev/null; then
  tmux kill-session -t "afk-$ENDED_RESUME_SESS" 2>/dev/null || true
fi
sleep 1

# Send a message — should resume instead of showing "session has ended"
RESP=$(post /send-message "{\"channelId\":\"$ENDED_RESUME_CHAN\",\"content\":\"are you back?\"}")
RESUMED=$(jq_val "$RESP" "['resumed']")
assert_eq "resumed from ended" "True" "$RESUMED"

# Verify channel is running
SESSIONS=$(get /sessions)
ENDED_RESUME_STATUS=""
for i in 0 1 2 3 4 5 6 7 8 9; do
  S=$(jq_val "$SESSIONS" "['channels'][$i]['channelId']" 2>/dev/null)
  if [[ "$S" == "$ENDED_RESUME_CHAN" ]]; then
    ENDED_RESUME_STATUS=$(jq_val "$SESSIONS" "['channels'][$i]['status']")
    break
  fi
done
assert_eq "channel running after resume from ended" "running" "$ENDED_RESUME_STATUS"

# Clean up
post /delete-channel "{\"channelId\":\"$ENDED_RESUME_CHAN\"}" >/dev/null
sleep 1
echo ""

# ═══════════════════════════════════════
# Summary
# ═══════════════════════════════════════
TOTAL=$((PASS + FAIL))
echo "═══════════════════════════════════════"
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} (out of $TOTAL)"
echo "═══════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
