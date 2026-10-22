FROM node:14-alpine
WORKDIR /app
COPY . .
RUN npm ci --only=production
CMD ["node", "src/server.js"]
