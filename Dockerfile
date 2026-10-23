FROM grafana/k6:1.8.2 AS k6

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=k6 /usr/bin/k6 /usr/local/bin/k6
COPY runner/package.json ./runner/package.json
COPY runner/config.js ./runner/config.js
COPY runner/server.js ./runner/server.js
COPY scripts/load-test.js ./scripts/load-test.js
RUN addgroup -S runner && adduser -S -G runner runner \
    && chown -R runner:runner /app
USER runner
EXPOSE 3000
CMD ["node", "runner/server.js"]
