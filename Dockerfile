# Albany County Crime Tracker — production image.
# Uses a Dockerfile (not Nixpacks/Railpack) so ffmpeg is GUARANTEED present for
# the Whisper scanner pipeline. Railway auto-detects this Dockerfile and builds it.
FROM python:3.11-slim

# System deps: ffmpeg for clean Broadcastify stream capture, curl for healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application source.
COPY . .

# Railway's HTTP networking forwards to port 8080 for this service (matches the
# internal domain / FASTAPI_URL). Bind there by default; PORT can still override.
ENV PORT=8080
EXPOSE 8080

# Shell form so ${PORT} expands at container start.
CMD uvicorn api_server:app --host 0.0.0.0 --port ${PORT:-8000}
