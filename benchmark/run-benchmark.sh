#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

COMPARE_FRAMEWORKS="react-hooks react-compiler-hooks react-rxjs react-mobX react-zustand react-redux"
# 01_ 02_ 03_ 04_ 05_ 06_ 07_ 08_ 09_ 21_ 22_ 23_ 24_ 25_ 26_
BENCHMARKS=""
PORT=3000

echo "=== statelift benchmark runner ==="
echo ""
echo "frameworks: ${COMPARE_FRAMEWORKS:-none}"
echo "benchmarks: ${BENCHMARKS:-all}"
echo ""
docker compose down 2>/dev/null || true

# prep results directory
mkdir -p results
chmod 777 results

# run benchmarks
echo "starting benchmark container..."
echo ""
export COMPARE_FRAMEWORKS BENCHMARKS
env UID="$(id -u)" GID="$(id -g)" docker compose up --build

# check results directory
if [ ! -d "results/table" ]; then
  echo ""
  echo "error: results not generated"
  exit 1
fi

echo ""
echo "=== serving results ==="
echo "open http://localhost:${PORT} to view results"
echo "press ctrl+c to stop"
echo ""

npx serve results/table -p "${PORT}"
