FROM python:3.13-slim

WORKDIR /app

# Install system dependencies for beautifulsoup4 html parser
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create directory for generated graphics
RUN mkdir -p generated_graphics

# Cloud Run sets PORT env var
ENV PORT=8080

EXPOSE 8080

CMD ["python", "main.py"]
