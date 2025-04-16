# Dockerfile Otimizado para Assistente de Voz OpenAI Realtime com Baixa Latência
FROM python:3.10-slim-bookworm

# Configuração do ambiente
ENV PYTHONUNBUFFERED=1 \
    # Não defina a chave aqui - passe como variável de ambiente ao executar
    OPENAI_API_KEY="" \
    # Porta da aplicação
    PORT=5000 \
    # Configuração para otimizar a performance de WebSockets
    PYTHONOPTIMIZE=1

# Instalar ffmpeg para processamento de áudio e dependências de rede
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    ffmpeg \
    net-tools \
    iputils-ping \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Configurar diretório de trabalho
WORKDIR /app

# Instalar dependências primeiro (melhor para cache de layers)
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copiar código-fonte
COPY . .

# Expor porta
EXPOSE ${PORT}

# Script de saúde/validação das configurações
RUN echo '#!/bin/bash\n\
if [ -z "$OPENAI_API_KEY" ]; then\n\
  echo "ERRO: OPENAI_API_KEY não definida. Execute com -e OPENAI_API_KEY=sua_chave_api"\n\
  exit 1\n\
fi\n\
\n\
echo "Iniciando assistente de voz com configurações otimizadas para baixa latência..."\n\
exec python server.py\n\
' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Comando de inicialização
ENTRYPOINT ["/app/entrypoint.sh"]