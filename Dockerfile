FROM node:20-slim

# Install Python, pip, and ffmpeg (yt-dlp needs these on the server)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Make "python" and "pip" resolve (Debian only ships python3/pip3 by default)
RUN ln -sf /usr/bin/python3 /usr/bin/python && ln -sf /usr/bin/pip3 /usr/bin/pip

WORKDIR /app

# Install yt-dlp
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

# Install Node dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
