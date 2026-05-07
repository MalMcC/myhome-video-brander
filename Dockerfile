FROM node:20-slim

# Install ffmpeg and font tools, then download DM Sans Bold (matches MyHome by MyPorta logo)
RUN apt-get update && apt-get install -y ffmpeg wget fontconfig && rm -rf /var/lib/apt/lists/* && \
    mkdir -p /usr/share/fonts/truetype/dmsans && \
    wget -q -O /usr/share/fonts/truetype/dmsans/DMSans-Bold.ttf \
      "https://github.com/googlefonts/dm-fonts/raw/main/Sans/fonts/ttf/DMSans-Bold.ttf" && \
    wget -q -O /usr/share/fonts/truetype/dmsans/DMSans-Regular.ttf \
      "https://github.com/googlefonts/dm-fonts/raw/main/Sans/fonts/ttf/DMSans-Regular.ttf" && \
    fc-cache -fv

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3456
CMD ["node", "server.js"]
