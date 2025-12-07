#!/bin/bash
set -e

export CHROME_FLAGS="--no-sandbox --disable-gpu --disable-dev-shm-usage"

cd /app/js-framework-benchmark
echo "=== js-framework-benchmark runner ==="
echo ""

if [ "${COMPARE_FRAMEWORKS}" = "none" ]; then
  COMPARE_FRAMEWORKS=""
elif [ -z "${COMPARE_FRAMEWORKS+x}" ]; then
  COMPARE_FRAMEWORKS="react-hooks react-zustand react-mobX"
fi
BENCHMARKS="${BENCHMARKS:-}"

echo "comparing statelift against: $COMPARE_FRAMEWORKS"

echo ""
echo "=== setting up react-statelift ==="
cp -r /react-statelift frameworks/keyed/react-statelift

cd frameworks/keyed/react-statelift
cat >package.json <<'EOF'
{
  "name": "js-framework-benchmark-react-statelift",
  "version": "1.0.0",
  "description": "React + Statelift benchmark",
  "license": "Apache-2.0",
  "js-framework-benchmark": {
    "frameworkVersion": "react19+statelift",
    "frameworkHomeURL": "https://github.com/user/statelift"
  },
  "scripts": {
    "dev": "webpack --config webpack.config.js --watch --mode=development",
    "build-prod": "webpack --config webpack.config.js --mode=production"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "statelift": "file:/statelift"
  },
  "devDependencies": {
    "@babel/core": "^7.26.0",
    "@babel/preset-env": "^7.26.0",
    "@babel/preset-react": "^7.26.3",
    "babel-loader": "^9.2.1",
    "terser-webpack-plugin": "^5.3.10",
    "webpack": "^5.97.1",
    "webpack-cli": "^5.1.4"
  }
}
EOF

npm install
npm run build-prod
cd /app/js-framework-benchmark

echo ""
echo "=== building comparison frameworks ==="
for fw in $COMPARE_FRAMEWORKS; do
  echo "building keyed/$fw..."
  cd "frameworks/keyed/$fw"
  npm ci || npm install
  npm run build-prod
  cd /app/js-framework-benchmark
done

echo ""
echo "=== starting server ==="
npm start &
SERVER_PID=$!
sleep 3

FRAMEWORK_LIST="keyed/react-statelift"
for fw in $COMPARE_FRAMEWORKS; do
  FRAMEWORK_LIST="$FRAMEWORK_LIST keyed/$fw"
done

# run benchmarks
echo ""
echo "=== running benchmarks ==="
echo "frameworks: $FRAMEWORK_LIST"

BENCH_ARGS="--framework $FRAMEWORK_LIST"
if [ -n "$BENCHMARKS" ]; then
  BENCH_ARGS="$BENCH_ARGS --benchmark $BENCHMARKS"
fi

npm run bench -- $BENCH_ARGS --headless --chromeBinary /usr/local/bin/google-chrome

# generate results
echo ""
echo "=== generating results ==="
npm run results

# copy results to output
echo ""
echo "=== copying results ==="
mkdir -p /results
cp -r webdriver-ts/results /results/raw
cp -r webdriver-ts-results/dist /results/table

# summary
echo ""
echo "=== benchmark complete ==="
echo ""
echo "results saved to /results/"
echo "  - /results/raw/     : raw JSON results"
echo "  - /results/table/   : HTML results table"
echo ""
echo "to view results, open results/table/index.html in a browser"

# kill server
kill $SERVER_PID 2>/dev/null || true
