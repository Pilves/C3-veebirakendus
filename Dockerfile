# Node 26 runs the TypeScript sources directly, so there is no build stage and no compiler
# in the image. The Debian release is named in the tag because the plain "-slim" tag
# changes distribution between Node majors.
FROM node:26-trixie-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is rebuilt only when the lock file changes.
# npm ci installs exactly what package-lock.json says; dev dependencies stay out.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY data ./data

# Inside the container the server must listen on all interfaces to be reachable through
# the published port. Who can reach it from outside is decided in compose.yaml.
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000

# The image's unprivileged user: the app only reads its own files.
USER node
CMD ["node", "src/server.ts"]
