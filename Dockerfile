# Zero npm dependencies: only Node 22 (built-in http + sqlite).
FROM node:22-slim
WORKDIR /app
COPY server ./server
COPY web ./web
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
