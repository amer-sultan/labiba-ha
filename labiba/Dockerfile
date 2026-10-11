FROM node:20-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./
CMD ["node", "index.js"]
