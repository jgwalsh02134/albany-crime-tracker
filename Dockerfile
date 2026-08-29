# Albany County Crime Tracker — Railway production image (Node / TanStack Start)
FROM node:22-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Auth is off; this file is the build-flag carrier expected by with-app-env.
RUN mkdir -p .grok && printf '%s\n' '{"VITE_AUTH_ENABLED":"false"}' > .grok/app-env.json

ENV NODE_ENV=production
ENV NITRO_PRESET=node-server
ENV HOST=0.0.0.0
ENV PORT=8080
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=8080

RUN npm run build

EXPOSE 8080

CMD ["node", ".output/server/index.mjs"]
