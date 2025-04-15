# Dockerfile (v3 - OpenAI S2S com Resample no Backend)

FROM python:3.10-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    OPENAI_API_KEY="" 

# ***** MODIFICADO: Adicionar ffmpeg *****
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*
# ***************************************

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 5000
CMD ["python", "server.py"]