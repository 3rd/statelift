FROM node:22.20.0-bookworm

ARG BUN_VERSION=1.4.0
ARG HARNESS_COMMIT=a0d4d1dd9b3f20d3c5c9a451fb3ba09935d7834a

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  fonts-liberation \
  git \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libatspi2.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  wget \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN wget -q \
    "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    -O /tmp/google-chrome-stable.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends /tmp/google-chrome-stable.deb \
  && rm -rf /tmp/google-chrome-stable.deb /var/lib/apt/lists/*

RUN git init /app/js-framework-benchmark \
  && cd /app/js-framework-benchmark \
  && git remote add origin https://github.com/krausest/js-framework-benchmark.git \
  && git fetch --depth 1 origin "$HARNESS_COMMIT" \
  && git checkout --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$HARNESS_COMMIT"

WORKDIR /app/js-framework-benchmark
RUN npm install --global "bun@$BUN_VERSION" \
  && npm run install-local \
  && cd frameworks/keyed/react-mobX \
  && npm ci \
  && npm run build-prod \
  && cd ../legend-state \
  && npm ci \
  && npm run build-prod \
  && cd ../react-zustand \
  && npm ci \
  && npm run build-prod

RUN printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exec /usr/bin/google-chrome --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"' \
  > /usr/local/bin/google-chrome \
  && chmod +x /usr/local/bin/google-chrome \
  && rm -rf \
    /app/js-framework-benchmark/webdriver-ts/results \
    /app/js-framework-benchmark/webdriver-ts/results.json \
    /app/js-framework-benchmark/webdriver-ts/traces \
  && mkdir -p \
    /app/js-framework-benchmark/webdriver-ts/results \
    /app/js-framework-benchmark/webdriver-ts/traces \
    /app/js-framework-benchmark/webdriver-ts-results/dist \
    /work \
    /tmp/benchmark-home \
  && chmod 777 \
    /app/js-framework-benchmark/frameworks/keyed \
    /app/js-framework-benchmark/webdriver-ts \
    /app/js-framework-benchmark/webdriver-ts/results \
    /app/js-framework-benchmark/webdriver-ts/traces \
    /app/js-framework-benchmark/webdriver-ts-results \
    /app/js-framework-benchmark/webdriver-ts-results/dist \
    /app/js-framework-benchmark/webdriver-ts-results/node_modules \
    /app/js-framework-benchmark/webdriver-ts-results/src \
    /tmp/benchmark-home \
    /work \
  && chmod 666 /app/js-framework-benchmark/webdriver-ts-results/src/results.ts

COPY --chmod=755 run-benchmark-internal.sh /app/run-benchmark.sh

ENV HOME=/tmp/benchmark-home
ENV CHROME_BINARY=/usr/local/bin/google-chrome
CMD ["/app/run-benchmark.sh"]
