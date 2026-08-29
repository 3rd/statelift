#!/usr/bin/env bash
set -euo pipefail

HARNESS_ROOT=/app/js-framework-benchmark
RESULTS_DIRECTORY=/results
SERVER_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

echo "=== building the local Statelift package ==="
rm -rf /work/statelift /work/artifacts
mkdir -p /work/statelift /work/artifacts
cp -a /statelift/. /work/statelift/
rm -rf /work/statelift/node_modules /work/statelift/dist

cd /work/statelift
bun install --frozen-lockfile --ignore-scripts
bun run build
PACKAGE_NAME="$(npm pack --ignore-scripts --pack-destination /work/artifacts | tail -n 1)"
PACKAGE_PATH="/work/artifacts/$PACKAGE_NAME"
test -f "$PACKAGE_PATH"

echo "=== building the Statelift benchmark entry ==="
cd "$HARNESS_ROOT"
rm -rf frameworks/keyed/react-statelift
cp -a /react-statelift frameworks/keyed/react-statelift

cd frameworks/keyed/react-statelift
npm ci --ignore-scripts
npm install --no-save --package-lock=false --ignore-scripts "$PACKAGE_PATH"
node --test src/benchmark-state.test.mjs
npm run build-prod

cd "$HARNESS_ROOT"
test -f frameworks/keyed/react-statelift/dist/main.js
test -f frameworks/keyed/react-mobX/dist/main.js
test -f frameworks/keyed/legend-state/dist/main.js
test -f frameworks/keyed/react-zustand/dist/main.js

echo "=== starting the upstream benchmark server ==="
npm start > /tmp/statelift-benchmark-server.log 2>&1 &
SERVER_PID=$!
wget \
  --quiet \
  --spider \
  --retry-connrefused \
  --tries=60 \
  --timeout=1 \
  --waitretry=1 \
  http://127.0.0.1:8080/frameworks/keyed/react-statelift/

frameworks=(
  keyed/react-statelift
  keyed/react-mobX
  keyed/legend-state
  keyed/react-zustand
)

echo "=== checking keyed behavior with the upstream validator ==="
cd "$HARNESS_ROOT/webdriver-ts"
LANG=en_US.UTF-8 node dist/isKeyed.js \
  --framework "${frameworks[@]}" \
  --headless \
  --chromeBinary /usr/local/bin/google-chrome

benchmark_arguments=(--framework "${frameworks[@]}")
if [ -n "${BENCHMARKS:-}" ]; then
  read -r -a benchmarks <<< "$BENCHMARKS"
  benchmark_arguments+=(--benchmark "${benchmarks[@]}")
fi

echo "=== running the upstream benchmark ==="
LANG=en_US.UTF-8 node dist/benchmarkRunner.js \
  "${benchmark_arguments[@]}" \
  --headless \
  --chromeBinary /usr/local/bin/google-chrome

echo "=== generating the upstream report ==="
cd "$HARNESS_ROOT"
npm run results
cp -a webdriver-ts/results "$RESULTS_DIRECTORY/raw"
cp -a webdriver-ts-results/dist "$RESULTS_DIRECTORY/table"
chmod -R a+rwX "$RESULTS_DIRECTORY/raw" "$RESULTS_DIRECTORY/table"

echo "=== benchmark complete ==="
