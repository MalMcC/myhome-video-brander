FROM node:20-slim

# FFmpeg renders the approved masters and DejaVu Sans supplies closing-card text.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3456
CMD ["node", "server.js"]
