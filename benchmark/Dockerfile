FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
  wget \
  gnupg \
  ca-certificates \
  fonts-liberation \
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
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# chrome
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# clone js-framework-benchmark
RUN git clone --depth 1 https://github.com/krausest/js-framework-benchmark.git /app/js-framework-benchmark

WORKDIR /app/js-framework-benchmark

# install dependencies
RUN npm ci
RUN npm run install-local

# prep dirs
RUN chmod -R 777 /app/js-framework-benchmark/frameworks/keyed
RUN chmod -R 777 /app/js-framework-benchmark/webdriver-ts
RUN chmod -R 777 /app/js-framework-benchmark/webdriver-ts-results

# create chrome wrapper with sandbox disabled
RUN echo '#!/bin/bash\nexec /usr/bin/google-chrome-stable --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"' > /usr/local/bin/google-chrome \
  && chmod +x /usr/local/bin/google-chrome

# copy runner
COPY --chmod=755 run-benchmark-internal.sh /app/run-benchmark.sh

EXPOSE 8080

CMD ["/app/run-benchmark.sh"]
