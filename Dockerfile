FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY sdk ./sdk
COPY dashboard ./dashboard
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
USER node
CMD ["node", "server/index.js"]
