FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY config ./config
# No npm install needed: zero runtime dependencies.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
