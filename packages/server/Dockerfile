FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Build stage
FROM base AS build
WORKDIR /usr/src/app

# Copy entire repository to access workspace configs and lockfiles
COPY . .

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Build the server package
RUN pnpm --filter @sohappy/server run build

# Deploy server package to a clean directory
# This extracts only the necessary files and production dependencies/node_modules for the server
RUN pnpm --filter @sohappy/server deploy --legacy --prod /prod/server

# Final production stage
FROM base AS server
WORKDIR /app

# Copy the deployed application from the build stage
COPY --from=build /prod/server /app

# Expose the API port
EXPOSE 3010

# Start the server
CMD [ "node", "dist/index.js" ]
