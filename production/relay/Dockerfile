# Public market-data relay only. No WordPress, trading, or exchange credentials.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node relay/binance-public-relay.mjs ./binance-public-relay.mjs
COPY --chown=node:node relay/relay-healthcheck.mjs ./relay-healthcheck.mjs
USER node
ENTRYPOINT ["node","/app/binance-public-relay.mjs"]
