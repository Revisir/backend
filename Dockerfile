FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME/bin:$PATH"
RUN corepack enable pnpm
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN npm i -g tsx
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile 
RUN pnpm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/index.js ./dist/
COPY --from=build /app/dist/index.js.map ./dist/
COPY --from=build /app/dist/instrumentation.js ./dist/
COPY --from=build /app/dist/instrumentation.js.map ./dist/
EXPOSE 5000
CMD [ "node", "--enable-source-maps", "--import", "./dist/instrumentation.js", "dist/index.js" ]