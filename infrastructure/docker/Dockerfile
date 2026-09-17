FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json ./
COPY tsconfig.base.json ./
COPY tsconfig.json ./
COPY apps ./apps
COPY images ./images
RUN npm install
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bluez dbus \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/images ./images
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "apps/backend"]
