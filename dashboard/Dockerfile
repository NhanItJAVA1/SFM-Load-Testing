FROM node:22-alpine AS build
WORKDIR /dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=4173
WORKDIR /app
COPY dashboard/server.js ./dashboard/server.js
COPY runner/config.js ./runner/config.js
COPY --from=build /dashboard/dist ./dashboard/dist
USER node
EXPOSE 4173
CMD ["node", "dashboard/server.js"]
