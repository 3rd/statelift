#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

RUN_ID="${RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)-statelift-upstream}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "error: RUN_ID may contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi

mkdir -p "$PWD/results"
RUN_DIRECTORY="$PWD/results/$RUN_ID"
if ! mkdir -m 0777 "$RUN_DIRECTORY"; then
  echo "error: run directory already exists: $RUN_DIRECTORY" >&2
  exit 1
fi

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
export HOST_GID HOST_UID RUN_DIRECTORY

echo "=== Statelift upstream js-framework-benchmark ==="
echo "frameworks: keyed/react-statelift, keyed/react-mobX, keyed/legend-state, keyed/react-zustand"
echo "results: $RUN_DIRECTORY"

docker compose build
docker compose run --rm benchmark

if [ ! -d "$RUN_DIRECTORY/raw" ] || [ ! -d "$RUN_DIRECTORY/table" ]; then
  echo "error: upstream benchmark did not produce raw results and an HTML report" >&2
  exit 1
fi

echo
echo "raw results: $RUN_DIRECTORY/raw"
echo "HTML report: $RUN_DIRECTORY/table/index.html"
