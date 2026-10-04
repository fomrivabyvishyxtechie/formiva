FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install && apk add --no-cache curl
COPY . .
CMD ["node", "dist/index.js"]
