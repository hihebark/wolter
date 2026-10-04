#!/usr/bin/env bash
# Populates the running example app (npm run start) with realistic traffic
# so the dashboard at http://localhost:3000/wolter has something to show:
# requests, queries (including a deliberate N+1 for the duplicate-query
# detector), and exceptions.
set -euo pipefail
BASE=${1:-http://localhost:3000}

echo "Seeding $BASE ..."

names=(Alice Bob Carol Dave Eve Frank Grace Heidi)
for name in "${names[@]}"; do
  curl -s -o /dev/null -X POST "$BASE/users" -H 'Content-Type: application/json' -d "{\"name\":\"$name\"}"
done

for _ in $(seq 1 25); do
  curl -s -o /dev/null "$BASE/users"
done

# N+1 endpoint — one call already produces a duplicate-flagged trace; a few
# more give the Requests table's percentile pills something to filter on.
for _ in $(seq 1 6); do
  curl -s -o /dev/null "$BASE/orders"
done

for _ in $(seq 1 8); do
  curl -s -o /dev/null "$BASE/boom"
done

echo "Done. Dashboard: $BASE/wolter"
