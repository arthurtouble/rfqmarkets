FROM cgr.dev/chainguard/wolfi-base@sha256:a4db868f63ff308c30256f84bf9ffca14ea93444b9626dd2f06b718df086de36 AS build
RUN apk upgrade --no-cache \
 && apk add --no-cache \
      nodejs-24=24.21.0-r1 \
      npm=12.0.2-r0 \
      python-3.11=3.11.16-r7 \
      py3.11-pip=26.2.1-r1
WORKDIR /app
COPY services/hedger/requirements.lock /tmp/requirements.lock
RUN python3.11 -m venv /opt/hyperliquid \
 && /opt/hyperliquid/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/requirements.lock \
 && /opt/hyperliquid/bin/python -c 'import hyperliquid.exchange, hyperliquid.info' \
 && rm -rf /opt/hyperliquid/lib/python3.11/site-packages/pip* \
            /opt/hyperliquid/lib/python3.11/site-packages/setuptools* \
            /opt/hyperliquid/bin/pip*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM cgr.dev/chainguard/wolfi-base@sha256:a4db868f63ff308c30256f84bf9ffca14ea93444b9626dd2f06b718df086de36
RUN apk upgrade --no-cache \
 && apk add --no-cache \
      ca-certificates=20260611-r1 \
      nodejs-24=24.21.0-r1 \
      python-3.11=3.11.16-r7
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=build /opt/hyperliquid /opt/hyperliquid
COPY --from=build /app/node_modules ./node_modules
COPY packages ./packages
COPY services ./services
COPY scripts ./scripts
USER 65532:65532
ENTRYPOINT ["node", "--import", "tsx", "scripts/persistent-service.ts"]
