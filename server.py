# server.py - Servidor otimizado para Assistente de Voz OpenAI Realtime
import os
import sys
import base64
import asyncio
import traceback
import json
import logging
import io  # Importado mas não usado diretamente no código fornecido
import threading
import queue
from typing import Dict, Optional, Any
from datetime import datetime

import websockets
import numpy as np # Importado mas não usado diretamente no código fornecido
from pydub import AudioSegment
from flask import Flask, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit, disconnect
import colorlog
from flask_compress import Compress

# Configuração de logging com cores
handler = colorlog.StreamHandler()
handler.setFormatter(colorlog.ColoredFormatter(
    '%(log_color)s%(asctime)s [%(levelname)s] %(message)s',
    log_colors={
        'DEBUG': 'cyan',
        'INFO': 'green',
        'WARNING': 'yellow',
        'ERROR': 'red',
        'CRITICAL': 'red,bg_white',
    }
))
logger = colorlog.getLogger('voice-assistant')
logger.addHandler(handler)
logger.setLevel(logging.INFO)

# Inicialização da aplicação Flask
app = Flask(__name__)
CORS(app) # Habilita CORS para permitir requisições de diferentes origens (ex: frontend web)
compress = Compress(app) # Habilita compressão (gzip) para respostas

# Configurações para WebSocket (Socket.IO)
SOCKET_PING_TIMEOUT = 5  # Segundos para timeout de ping do cliente
SOCKET_PING_INTERVAL = 3  # Intervalo entre pings em segundos

# Inicialização do SocketIO
socketio = SocketIO(
    app,
    cors_allowed_origins="*", # Permite conexões de qualquer origem (ajuste em produção)
    async_mode='threading', # Modo assíncrono recomendado para Flask
    logger=False, # Desabilita logs do SocketIO (já temos o nosso logger)
    engineio_logger=False, # Desabilita logs do Engine.IO
    ping_timeout=SOCKET_PING_TIMEOUT,
    ping_interval=SOCKET_PING_INTERVAL,
    max_http_buffer_size=5*1024*1024,  # Aumenta o buffer para transferência mais rápida de dados iniciais
)

# Variáveis globais para gerenciar estado dos clientes
openai_api_key = None
client_tasks: Dict[str, asyncio.Task] = {} # Armazena as tasks asyncio de gerenciamento por cliente
client_audio_queues: Dict[str, asyncio.Queue] = {} # Filas de áudio por cliente
client_sample_rates: Dict[str, int] = {} # Taxa de amostragem original do áudio do cliente
client_vad_configs: Dict[str, dict] = {}  # Armazena configuração de VAD por cliente
initialization_done = False # Flag para garantir inicialização única
OPENAI_MODEL = "gpt-4o-mini-realtime-preview"  # Modelo OpenAI para streaming de áudio em tempo real

# Configuração de VAD (Voice Activity Detection) semântico padrão
DEFAULT_VAD_CONFIG = {
    "type": "semantic_vad", # Tipo de VAD
    "eagerness": "medium",  # Agressividade do VAD (low, medium, high) - controla quão rápido detecta o fim da fala
    "create_response": True, # Permite que a API comece a gerar resposta antes do fim da fala
    "interrupt_response": True # Permite que a fala do usuário interrompa a resposta da IA
}

# Partes do prompt do sistema que são estáticas e podem ser cacheadas pela API
STATIC_SYSTEM_PROMPT = """Você é um assistente em português do Brasil.
Responda sempre em português brasileiro com sotaque neutro.
Seja conciso e claro em suas respostas.
Priorize respostas curtas e diretas para manter a conversa fluída.
"""

# --- Rotas Flask ---

@app.route('/')
def index():
    """Serve o arquivo index.html principal."""
    logger.debug("Servindo index.html")
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve outros arquivos estáticos (CSS, JS, imagens, etc.)."""
    logger.debug(f"Servindo arquivo estático: {path}")
    return send_from_directory('.', path)

# --- Funções Auxiliares ---

def initialize_env():
    """Inicializa variáveis de ambiente e configurações globais."""
    global openai_api_key, initialization_done

    if initialization_done:
        return

    logger.info("Inicializando configurações do servidor...")

    # Verificar chave API OpenAI
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key:
        logger.critical("ERRO FATAL: OPENAI_API_KEY não definida no ambiente. Defina a variável de ambiente.")
        sys.exit(1) # Encerra o servidor se a chave não estiver definida
    else:
        # Mascarar a chave para o log por segurança
        masked_key = openai_api_key[:5] + "*" * 10 + openai_api_key[-5:] if len(openai_api_key) > 20 else "*" * len(openai_api_key)
        logger.info(f"OpenAI API Key configurada: {masked_key}")

    initialization_done = True
    logger.info("Inicialização concluída com sucesso!")

# --- Lógica de Comunicação com OpenAI (Asyncio) ---

async def openai_sender(client_sid: str, ws: websockets.WebSocketClientProtocol, audio_queue: asyncio.Queue):
    """Envia chunks de áudio da fila para a API OpenAI via WebSocket."""
    logger.info(f"[Sender {client_sid[:6]}] Iniciado. Aguardando chunks de áudio...")

    try:
        while True:
            # Aguardar dados na fila com timeout para evitar bloqueio infinito
            # e permitir verificar se o WebSocket fechou
            try:
                # Espera por um item na fila por até 10 segundos
                audio_chunk_base64 = await asyncio.wait_for(audio_queue.get(), timeout=10.0)

                # 'None' na fila é o sinal para encerrar esta task (enviado no disconnect ou stop_recording)
                if audio_chunk_base64 is None:
                    logger.info(f"[Sender {client_sid[:6]}] Recebido sinal de encerramento (None).")
                    # Enviar evento de fim de stream para a API
                    end_event = {"type": "input_audio_buffer.stream_end"}
                    try:
                       await asyncio.wait_for(ws.send(json.dumps(end_event)), timeout=5.0)
                       logger.info(f"[Sender {client_sid[:6]}] Evento 'stream_end' enviado para OpenAI.")
                    except Exception as send_err:
                       logger.warning(f"[Sender {client_sid[:6]}] Erro ao enviar 'stream_end': {send_err}")
                    break # Sai do loop while

                # Preparar e enviar o evento de áudio para a OpenAI
                audio_event = {
                    "type": "input_audio_buffer.append",
                    "audio": audio_chunk_base64 # Áudio já está em base64 PCM16@16kHz
                }

                # Envia o chunk de áudio com timeout
                await asyncio.wait_for(
                    ws.send(json.dumps(audio_event)),
                    timeout=5.0 # Timeout para envio
                )
                # logger.debug(f"[Sender {client_sid[:6]}] Chunk de áudio enviado.") # Log muito verboso

                audio_queue.task_done() # Marcar item como processado na fila asyncio

            except asyncio.TimeoutError:
                # Timeout ao esperar item na fila ou ao enviar
                if ws.closed:
                    logger.warning(f"[Sender {client_sid[:6]}] Timeout e WebSocket OpenAI já estava fechado. Encerrando sender.")
                    break # Sai do loop while se a conexão caiu
                # Se o WebSocket ainda estiver aberto, apenas continua esperando por mais dados na fila
                logger.debug(f"[Sender {client_sid[:6]}] Timeout na fila/envio, WebSocket aberto. Continuando...")
                continue # Volta para o início do loop while

            except websockets.exceptions.ConnectionClosed:
                logger.warning(f"[Sender {client_sid[:6]}] Conexão com OpenAI fechada inesperadamente durante envio.")
                break # Sai do loop while

            except Exception as e:
                logger.error(f"[Sender {client_sid[:6]}] Erro inesperado ao enviar chunk: {type(e).__name__} - {e}")
                logger.debug(traceback.format_exc()) # Log completo em debug
                break # Sai do loop while em caso de erro grave

    finally:
        # Limpeza: Garante que a fila seja marcada como concluída se houver itens restantes
        # (embora o 'None' deva ter esvaziado)
        while not audio_queue.empty():
            try:
                audio_queue.get_nowait()
                audio_queue.task_done()
            except asyncio.QueueEmpty:
                break
            except Exception as qe:
                logger.warning(f"[Sender {client_sid[:6]}] Erro ao limpar fila no final: {qe}")
                break
        logger.info(f"[Sender {client_sid[:6]}] Finalizado.")


async def openai_receiver(client_sid: str, ws: websockets.WebSocketClientProtocol):
    """Recebe eventos e áudio da API OpenAI e repassa para o cliente via Socket.IO."""
    logger.info(f"[Receiver {client_sid[:6]}] Iniciado. Aguardando eventos da OpenAI...")

    # Indicadores para a interface do cliente
    processing_started = False # Flag para saber se já notificamos o início do processamento da IA

    try:
        while True:
            try:
                # Aguardar mensagem da OpenAI com timeout razoável
                message_str = await asyncio.wait_for(ws.recv(), timeout=60.0) # Timeout longo para esperar resposta da IA
                server_event = json.loads(message_str)
                event_type = server_event.get("type")

                # Log diferenciado para eventos frequentes (delta) para não poluir muito
                if event_type in ["response.audio.delta", "response.text.delta"]:
                    logger.debug(f"[Receiver {client_sid[:6]}] Evento recebido: {event_type}")
                else:
                    logger.info(f"[Receiver {client_sid[:6]}] Evento recebido: {event_type} | Detalhes: {server_event}")

                # --- Processamento otimizado para baixa latência ---

                # Detecção de fim de fala do usuário pela API (baseado no VAD)
                if event_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[Receiver {client_sid[:6]}] API (VAD) detectou fim da fala do usuário.")
                    socketio.emit('speech_stopped', {}, room=client_sid) # Notifica cliente

                    # Notificar cliente que o processamento da IA começou (se ainda não notificou)
                    if not processing_started:
                        logger.info(f"[Receiver {client_sid[:6]}] Emitindo 'processing_started' para o cliente.")
                        socketio.emit('processing_started', {}, room=client_sid)
                        processing_started = True

                # Chunk de áudio da resposta da IA
                elif event_type == "response.audio.delta":
                    audio_chunk_base64 = server_event.get("delta")
                    if audio_chunk_base64:
                        # Envio IMEDIATO para o cliente para tocar o áudio o quanto antes
                        socketio.emit('audio_chunk', {'audio': audio_chunk_base64}, room=client_sid)

                # Chunk de texto da resposta da IA (transcrição parcial ou final)
                elif event_type == "response.text.delta":
                    text_chunk = server_event.get("delta")
                    if text_chunk:
                        # Envio IMEDIATO para o cliente para exibir o texto
                        socketio.emit('text_chunk', {'text': text_chunk}, room=client_sid)

                # Detecção de início de fala do usuário pela API (baseado no VAD)
                elif event_type == "input_audio_buffer.speech_started":
                    logger.info(f"[Receiver {client_sid[:6]}] API (VAD) detectou início da fala do usuário.")
                    socketio.emit('speech_started', {}, room=client_sid) # Notifica cliente
                    processing_started = False # Reseta flag de processamento, pois o usuário começou a falar de novo

                # Início da resposta da IA (sinal para feedback visual no cliente)
                elif event_type == "response.created" or event_type == "response.output_item.added":
                    logger.info(f"[Receiver {client_sid[:6]}] API iniciou a criação/envio da resposta.")
                    socketio.emit('response_starting', {}, room=client_sid) # Notifica cliente

                # Fim da resposta completa da IA
                elif event_type == "response.done":
                    logger.info(f"[Receiver {client_sid[:6]}] API finalizou a resposta completa.")
                    socketio.emit('audio_stream_end', {}, room=client_sid) # Notifica cliente que a resposta acabou
                    processing_started = False # Reseta flag

                # Erros da API OpenAI
                elif "error" in str(event_type).lower() or event_type == "error":
                    error_details = server_event.get("message", str(server_event))
                    logger.error(f"[Receiver {client_sid[:6]}] ERRO recebido da API OpenAI: {error_details}")
                    socketio.emit(
                        'processing_error',
                        {'error': f'Erro da API OpenAI: {error_details}'},
                        room=client_sid
                    )
                    break # Encerra o receiver em caso de erro da API

                # Outros eventos informativos (podem ser úteis para debug)
                elif event_type == "session.start_ack":
                    logger.info(f"[Receiver {client_sid[:6]}] Confirmação de início de sessão recebida.")
                elif event_type == "input_audio_buffer.stream_end_ack":
                     logger.info(f"[Receiver {client_sid[:6]}] Confirmação de fim de stream de input recebida.")
                # Adicione mais 'elif' conforme necessário para outros eventos da API

            except asyncio.TimeoutError:
                logger.warning(f"[Receiver {client_sid[:6]}] Timeout ao aguardar mensagem da OpenAI ({ws.latency}s de latência). Verificando conexão...")
                # Verifica se a conexão ainda está ativa antes de desistir
                if ws.closed:
                     logger.error(f"[Receiver {client_sid[:6]}] Timeout e WebSocket OpenAI fechado. Encerrando receiver.")
                     socketio.emit('processing_error', {'error': 'Timeout/Desconexão na comunicação com a API OpenAI'}, room=client_sid)
                     break
                else:
                    logger.info(f"[Receiver {client_sid[:6]}] Timeout, mas WebSocket OpenAI ainda aberto. Continuando a esperar...")
                    continue # Tenta receber novamente

            except websockets.exceptions.ConnectionClosedOK:
                logger.info(f"[Receiver {client_sid[:6]}] Conexão com OpenAI fechada normalmente (pelo servidor ou cliente).")
                break # Sai do loop while

            except websockets.exceptions.ConnectionClosedError as e:
                logger.error(f"[Receiver {client_sid[:6]}] Conexão com OpenAI fechada com erro: {e.code} {e.reason}")
                socketio.emit('processing_error', {'error': f'Conexão perdida com a API OpenAI ({e.code})'}, room=client_sid)
                break # Sai do loop while

            except json.JSONDecodeError as e:
                logger.error(f"[Receiver {client_sid[:6]}] Erro ao decodificar JSON da OpenAI: {e} - Mensagem recebida: '{message_str}'")
                # Continua tentando receber, pode ter sido uma mensagem malformada isolada

            except Exception as e:
                logger.error(f"[Receiver {client_sid[:6]}] Erro inesperado ao receber/processar evento: {type(e).__name__} - {e}")
                logger.error(traceback.format_exc())
                socketio.emit('processing_error', {'error': f'Erro interno no servidor ao processar resposta: {e}'}, room=client_sid)
                break # Sai do loop while em caso de erro grave

    finally:
        # Garantir que o evento de fim de stream seja enviado ao cliente, mesmo se ocorrer erro,
        # mas APENAS se o cliente ainda estiver conectado no Socket.IO.
        # Usar socketio.server.manager é a forma correta de verificar em modo 'threading'.
        is_client_connected = client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set())

        if is_client_connected:
            logger.info(f"[Receiver {client_sid[:6]}] Garantindo envio de 'audio_stream_end' para cliente conectado.")
            socketio.emit('audio_stream_end', {}, room=client_sid)
        else:
            logger.info(f"[Receiver {client_sid[:6]}] Cliente já desconectado do Socket.IO, não enviando 'audio_stream_end' final.")
        logger.info(f"[Receiver {client_sid[:6]}] Finalizado.")


async def manage_openai_session(client_sid: str, audio_queue: asyncio.Queue):
    """Gerencia a conexão WebSocket completa com a API OpenAI para um cliente."""
    global openai_api_key

    logger.info(f"[Manager {client_sid[:6]}] Iniciando sessão OpenAI...")

    # Verificar novamente se a chave API está configurada (redundante, mas seguro)
    if not openai_api_key:
        logger.error(f"[Manager {client_sid[:6]}] Chave API OpenAI não configurada ao iniciar sessão.")
        socketio.emit('processing_error', {'error': 'Chave API OpenAI não configurada no servidor'}, room=client_sid)
        return # Aborta a função

    # Obter configuração de VAD específica do cliente ou usar padrão
    vad_config = client_vad_configs.get(client_sid, DEFAULT_VAD_CONFIG)
    logger.info(f"[Manager {client_sid[:6]}] Usando configuração VAD: {vad_config}")

    # Configurações da API OpenAI Realtime
    TARGET_INPUT_RATE = 16000  # Taxa de amostragem exigida pela OpenAI (PCM16)
    OPENAI_WEBSOCKET_URI = f"wss://api.openai.com/v1/realtime?model={OPENAI_MODEL}"
    headers = {
        "Authorization": f"Bearer {openai_api_key}",
        "OpenAI-Beta": "realtime=v1" # Header necessário para a API Realtime
    }

    ws = None
    sender_task = None
    receiver_task = None

    try:
        # 1. Conectar ao WebSocket da OpenAI
        logger.info(f"[Manager {client_sid[:6]}] Conectando a {OPENAI_WEBSOCKET_URI}...")
        # Aumentar timeout de conexão se necessário
        ws = await asyncio.wait_for(
            websockets.connect(
                OPENAI_WEBSOCKET_URI,
                extra_headers=headers,
                ping_interval=10, # Envia pings para manter a conexão viva
                ping_timeout=5   # Timeout para resposta do ping
            ),
            timeout=15.0 # Timeout para conexão inicial
        )
        logger.info(f"[Manager {client_sid[:6]}] Conectado à API OpenAI.")

        # 2. Configurar a sessão (formato de áudio, VAD, instruções, voz)
        logger.info(f"[Manager {client_sid[:6]}] Configurando sessão (Formato: PCM16, VAD, Instruções)...")

        # Configuração da sessão enviada para a API (apenas parâmetros documentados)
        session_config = {
            "type": "session.update",
            "session": {
                "input_audio_format": "pcm16", # Formato esperado pela API
                "turn_detection": vad_config, # Configuração do VAD
                # Instruções para o modelo - otimizadas para caching (parte estática no início)
                "instructions": STATIC_SYSTEM_PROMPT + f" A data e hora atual é {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}. Responda brevemente às perguntas do usuário, mantendo um tom conversacional.",
                "voice": "alloy" # Voz da OpenAI (outras opções: echo, fable, onyx, shimmer)
                # Removidos: input_audio_rate_hz, output_audio_format, output_audio_rate_hz (não documentados explicitamente para update)
            }
        }

        await asyncio.wait_for(
            ws.send(json.dumps(session_config)),
            timeout=5.0 # Timeout para enviar configuração
        )
        logger.info(f"[Manager {client_sid[:6]}] Configuração da sessão enviada.")

        # 3. Iniciar tasks de envio (sender) e recebimento (receiver) em paralelo
        logger.info(f"[Manager {client_sid[:6]}] Iniciando tasks de envio (sender) e recebimento (receiver)...")
        sender_task = asyncio.create_task(
            openai_sender(client_sid, ws, audio_queue),
            name=f"Sender_{client_sid[:6]}"
        )
        receiver_task = asyncio.create_task(
            openai_receiver(client_sid, ws),
            name=f"Receiver_{client_sid[:6]}"
        )

        # 4. Aguardar a conclusão da primeira tarefa (sender ou receiver)
        # Se uma delas terminar (por erro, desconexão normal, etc.), a outra deve ser cancelada.
        done, pending = await asyncio.wait(
            [sender_task, receiver_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        # 5. Lidar com tarefas concluídas e pendentes
        for task in done:
            task_name = task.get_name()
            try:
                # Verificar se a tarefa concluída gerou alguma exceção não tratada internamente
                task.result()
                logger.info(f"[Manager {client_sid[:6]}] Tarefa {task_name} concluída sem erros inesperados.")
            except asyncio.CancelledError:
                 logger.info(f"[Manager {client_sid[:6]}] Tarefa {task_name} foi cancelada.")
            except Exception as e:
                # Logar exceção da tarefa concluída (pode ser um erro que terminou a task)
                logger.warning(f"[Manager {client_sid[:6]}] Tarefa {task_name} concluída com exceção: {type(e).__name__} - {e}")
                # Se o receiver falhou, podemos querer notificar o cliente
                if task is receiver_task and not isinstance(e, websockets.exceptions.ConnectionClosedOK):
                     socketio.emit('processing_error', {'error': f'Erro na comunicação com OpenAI: {e}'}, room=client_sid)


        logger.info(f"[Manager {client_sid[:6]}] Uma das tasks (sender/receiver) terminou. Cancelando tarefas pendentes...")
        for task in pending:
            task_name = task.get_name()
            if not task.done(): # Verifica se já não terminou por outra razão
                logger.info(f"[Manager {client_sid[:6]}] Cancelando tarefa pendente: {task_name}")
                task.cancel()
                try:
                    await task # Aguardar o cancelamento efetivo e tratar exceção CancelledError
                except asyncio.CancelledError:
                    logger.info(f"[Manager {client_sid[:6]}] Tarefa {task_name} cancelada com sucesso.")
                except Exception as e:
                    logger.error(f"[Manager {client_sid[:6]}] Erro durante o cancelamento da tarefa {task_name}: {type(e).__name__} - {e}")

    except websockets.exceptions.InvalidURI:
        logger.critical(f"[Manager {client_sid[:6]}] URI inválida para WebSocket OpenAI: {OPENAI_WEBSOCKET_URI}")
        socketio.emit('processing_error', {'error': 'Configuração inválida do servidor OpenAI'}, room=client_sid)
    except websockets.exceptions.WebSocketException as e:
        logger.error(f"[Manager {client_sid[:6]}] Erro de WebSocket ao conectar/configurar OpenAI: {type(e).__name__} - {e}")
        socketio.emit('processing_error', {'error': f'Erro de comunicação inicial com OpenAI: {e}'}, room=client_sid)
    except asyncio.TimeoutError:
        logger.error(f"[Manager {client_sid[:6]}] Timeout ao conectar ou configurar a sessão OpenAI.")
        socketio.emit('processing_error', {'error': 'Timeout ao iniciar comunicação com OpenAI'}, room=client_sid)
    except Exception as e:
        logger.error(f"[Manager {client_sid[:6]}] Erro inesperado na gestão da sessão OpenAI: {type(e).__name__}: {e}")
        logger.error(traceback.format_exc())
        socketio.emit('processing_error', {'error': f'Erro interno crítico no servidor: {e}'}, room=client_sid)

    finally:
        # --- Limpeza de recursos ---
        logger.info(f"[Manager {client_sid[:6]}] Finalizando sessão e liberando recursos...")

        # Garantir cancelamento das tasks se ainda estiverem ativas (caso o finally seja atingido por exceção antes do wait)
        for task in [sender_task, receiver_task]:
             if task and not task.done():
                 logger.info(f"[Manager {client_sid[:6]}] Cancelando {task.get_name()} na limpeza final.")
                 task.cancel()
                 try:
                     await task # Espera o cancelamento
                 except asyncio.CancelledError:
                     logger.info(f"[Manager {client_sid[:6]}] {task.get_name()} cancelada na limpeza.")
                 except Exception as e:
                     logger.warning(f"[Manager {client_sid[:6]}] Erro ao cancelar {task.get_name()} na limpeza: {e}")


        # Fechar conexão WebSocket se estiver aberta
        if ws and not ws.closed:
            logger.info(f"[Manager {client_sid[:6]}] Fechando conexão WebSocket com OpenAI...")
            try:
                await ws.close(code=1000, reason="Client session ended") # Envia código de fechamento normal
                logger.info(f"[Manager {client_sid[:6]}] Conexão WebSocket fechada.")
            except Exception as e:
                logger.warning(f"[Manager {client_sid[:6]}] Erro ao fechar WebSocket na limpeza: {e}")

        # Remover referências das estruturas globais (importante para liberar memória)
        # Usar pop com default None para evitar KeyError se já removido
        client_tasks.pop(client_sid, None)
        client_audio_queues.pop(client_sid, None)
        client_sample_rates.pop(client_sid, None)
        client_vad_configs.pop(client_sid, None)  # Remover configuração de VAD

        # Enviar sinal de fim ao cliente (se ainda conectado) - O receiver já faz isso, mas como garantia
        is_client_connected = client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set())
        if is_client_connected:
             logger.info(f"[Manager {client_sid[:6]}] Enviando 'audio_stream_end' final (garantia) para o cliente.")
             socketio.emit('audio_stream_end', {}, room=client_sid)

        logger.info(f"[Manager {client_sid[:6]}] Sessão OpenAI finalizada e recursos liberados.")


# -------------------------------------
# Handlers de Eventos Socket.IO
# -------------------------------------

@socketio.on('connect')
def handle_connect():
    """Chamado quando um novo cliente se conecta via Socket.IO."""
    client_sid = request.sid
    logger.info(f"Cliente conectado: {client_sid[:6]} do IP: {request.remote_addr}")

    # Certificar que as variáveis de ambiente foram inicializadas (chama apenas na primeira conexão)
    if not initialization_done:
        initialize_env()

    # Verificar se a chave API está disponível (após tentativa de inicialização)
    if not openai_api_key:
        logger.error(f"Tentativa de conexão de {client_sid[:6]} falhou: Chave API OpenAI não configurada no servidor.")
        emit('processing_error', {'error': 'Erro crítico: API OpenAI não configurada no servidor. Contate o administrador.'})
        # Considerar desconectar o cliente aqui se a chave for essencial
        disconnect(client_sid)
        logger.info(f"Cliente {client_sid[:6]} desconectado por falta de API Key.")


@socketio.on('disconnect')
def handle_disconnect():
    """Chamado quando um cliente se desconecta."""
    client_sid = request.sid
    logger.info(f"Cliente desconectado: {client_sid[:6]}")

    # Sinalizar para a task `openai_sender` que ela deve terminar, colocando None na fila
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            # Colocar 'None' na fila sinaliza o fim para o sender
            audio_queue.put_nowait(None)
            logger.info(f"Sinal de término (None) enviado para a fila de áudio de {client_sid[:6]} devido à desconexão.")
        except asyncio.QueueFull: # Usar asyncio.QueueFull para asyncio.Queue
            logger.warning(f"Fila de áudio cheia ao tentar enviar sinal de término (disconnect) para {client_sid[:6]}. A task pode demorar a parar.")
        except Exception as e:
            logger.warning(f"Erro ao enviar sinal de término (disconnect) para a fila de {client_sid[:6]}: {e}")

    # A limpeza principal dos recursos (tasks, websocket, etc.) é feita no 'finally' do manage_openai_session
    # Aqui apenas removemos as configurações que não estão ligadas diretamente à task asyncio
    client_sample_rates.pop(client_sid, None)
    client_vad_configs.pop(client_sid, None)
    logger.debug(f"Dados de configuração local removidos para {client_sid[:6]}.")


@socketio.on('update_vad_config')
def handle_update_vad_config(data):
    """Atualiza a configuração de VAD para um cliente específico."""
    client_sid = request.sid

    if not data or not isinstance(data, dict):
        logger.warning(f"Cliente {client_sid[:6]} enviou configuração de VAD inválida: {data}")
        emit('vad_config_update_error', {'error': 'Configuração inválida enviada.'}, room=client_sid)
        return

    # Validar e/ou usar valores padrão (exemplo simples)
    valid_config = DEFAULT_VAD_CONFIG.copy() # Começa com o padrão
    valid_config["type"] = data.get("type", DEFAULT_VAD_CONFIG["type"]) # Mantém 'semantic_vad' se não especificado
    valid_config["eagerness"] = data.get("eagerness", DEFAULT_VAD_CONFIG["eagerness"])
    # Adicione validação para os valores de eagerness se necessário ('low', 'medium', 'high')
    valid_config["create_response"] = data.get("create_response", DEFAULT_VAD_CONFIG["create_response"])
    valid_config["interrupt_response"] = data.get("interrupt_response", DEFAULT_VAD_CONFIG["interrupt_response"])

    # Armazenar configuração validada para este cliente
    client_vad_configs[client_sid] = valid_config
    logger.info(f"Cliente {client_sid[:6]} atualizou configuração de VAD para: {valid_config}")

    # Enviar confirmação ao cliente com a configuração aplicada
    emit('vad_config_updated', {'success': True, 'config': valid_config}, room=client_sid)

    # Idealmente, se uma sessão já estiver ativa, deveríamos enviar um 'session.update' para a OpenAI
    # Isso adicionaria complexidade para verificar a task ativa e enviar o comando pelo WebSocket.
    # Por simplicidade, esta versão aplica a configuração na *próxima* sessão iniciada.


@socketio.on('interrupt_response')
def handle_interrupt(data=None):
    """Chamado quando o cliente solicita interrupção da resposta da IA."""
    client_sid = request.sid
    logger.info(f"Cliente {client_sid[:6]} solicitou interrupção da resposta da IA.")

    # A API Realtime lida com interrupção automaticamente se 'interrupt_response' for True no VAD.
    # O simples ato de enviar novo áudio (quando o usuário fala) deve interromper a IA.
    # No entanto, podemos explicitamente sinalizar o fim do *envio* de áudio do usuário anterior,
    # caso ele tenha parado de falar e a IA esteja respondendo, e ele queira parar a IA *sem* falar.

    # Enviar sinal de término para a fila de áudio (interrompe o envio do áudio *do usuário* para a API)
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            # Colocar None força o sender a parar de enviar áudio do usuário e enviar stream_end
            audio_queue.put_nowait(None)
            logger.info(f"Sinal de término (interrupção manual) enviado para a fila de áudio de {client_sid[:6]}")

            # Notificar o cliente que a interrupção foi *solicitada*.
            # A parada real da *resposta* da IA depende da API e do VAD.
            socketio.emit('response_interrupt_requested', {}, room=client_sid)

        except asyncio.QueueFull:
            logger.warning(f"Fila de áudio cheia ao tentar interromper {client_sid[:6]}.")
            socketio.emit('processing_error', {'error': 'Não foi possível processar a interrupção imediatamente.'}, room=client_sid)
        except Exception as e:
            logger.error(f"Erro ao enviar sinal de término para interrupção de {client_sid[:6]}: {e}")
            socketio.emit('processing_error', {'error': f'Erro ao processar interrupção: {e}'}, room=client_sid)
    else:
        logger.warning(f"Fila de áudio não encontrada para interrupção de {client_sid[:6]}. A sessão pode já ter terminado.")
        # Mesmo sem fila, notificar o cliente que o pedido foi recebido
        socketio.emit('response_interrupt_requested', {}, room=client_sid)


@socketio.on('start_recording')
def handle_start_recording(data):
    """Chamado quando o cliente inicia a gravação de áudio."""
    client_sid = request.sid
    client_sample_rate = data.get('sampleRate')

    if not client_sample_rate or not isinstance(client_sample_rate, int):
        logger.error(f"Cliente {client_sid[:6]} iniciou gravação sem informar sampleRate válido: {client_sample_rate}")
        emit('processing_error', {'error': 'Taxa de amostragem (sampleRate) inválida ou não informada.'}, room=client_sid)
        return

    logger.info(f"Cliente {client_sid[:6]} iniciou gravação (Taxa original: {client_sample_rate}Hz)")

    # Armazenar taxa de amostragem original do cliente
    client_sample_rates[client_sid] = client_sample_rate

    # Função interna para iniciar a tarefa asyncio em uma thread separada
    # Usamos socketio.start_background_task para compatibilidade com async_mode='threading'
    def start_session_task_thread():
        logger.info(f"Iniciando task de gerenciamento de sessão para {client_sid[:6]} em background thread.")

        # Verificar se já existe uma sessão ativa para este cliente (evita duplicação)
        if client_sid in client_audio_queues or client_sid in client_tasks:
             logger.warning(f"Tentativa de iniciar nova gravação para {client_sid[:6]} enquanto uma sessão já está ativa ou sendo limpa. Ignorando.")
             # Poderia emitir um erro para o cliente aqui
             # emit('processing_error', {'error': 'Sessão anterior ainda ativa.'}, room=client_sid)
             return

        # Verificar novamente a chave API (deve estar ok, mas por segurança)
        if not openai_api_key:
            logger.error(f"Chave API OpenAI não configurada ao iniciar task para {client_sid[:6]}")
            # Usar socketio.emit dentro da thread do background task
            socketio.emit('processing_error', {'error': 'Chave API OpenAI não configurada no servidor'}, room=client_sid)
            return

        # Criar uma nova fila de áudio asyncio para esta sessão
        # É crucial que a fila seja criada aqui, antes de ser passada para a corrotina
        audio_queue = asyncio.Queue()
        client_audio_queues[client_sid] = audio_queue
        logger.debug(f"Fila de áudio criada para {client_sid[:6]}")

        # Função wrapper para rodar a corrotina principal em um novo loop de eventos
        # dentro desta thread gerenciada pelo SocketIO
        async def run_main_task_in_loop():
            logger.debug(f"run_main_task_in_loop: Iniciando para {client_sid[:6]}")
            # Cria e agenda a corrotina principal que gerencia a sessão
            # A task é criada DENTRO do loop que será executado nesta thread
            task = asyncio.create_task(
                manage_openai_session(client_sid, audio_queue),
                name=f"Manager_{client_sid[:6]}"
            )
            client_tasks[client_sid] = task # Armazena a referência da task principal
            logger.info(f"Task {task.get_name()} criada e agendada no novo loop.")

            try:
                await task # Aguarda a conclusão da task (ou erro/cancelamento)
                logger.info(f"Task {task.get_name()} concluída naturalmente ou por erro interno.")
            except asyncio.CancelledError:
                logger.info(f"Task {task.get_name()} foi cancelada (provavelmente durante a limpeza).")
            except Exception as e:
                logger.error(f"Task {task.get_name()} falhou com exceção não tratada no manage_openai_session: {type(e).__name__}")
                logger.error(traceback.format_exc())
            finally:
                # Limpeza final DENTRO do loop asyncio, caso manage_openai_session não limpe tudo
                logger.info(f"Limpeza final na thread/loop para task {task.get_name()}.")
                client_tasks.pop(client_sid, None)
                # A fila e outras configs são limpas no finally do manage_openai_session ou no disconnect
                logger.debug(f"run_main_task_in_loop: Finalizado para {client_sid[:6]}")


        # Executar a função wrapper assíncrona em um novo loop de eventos nesta thread
        loop = None
        try:
            # Obter ou criar um loop de eventos para esta thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            logger.debug(f"Novo loop de eventos criado e definido para thread {threading.current_thread().name} ({client_sid[:6]})")
            loop.run_until_complete(run_main_task_in_loop())
            logger.info(f"Loop de eventos para {client_sid[:6]} completou execução.")
        except Exception as e:
            logger.error(f"Erro CRÍTICO ao executar o loop de eventos para {client_sid[:6]}: {type(e).__name__} - {e}")
            logger.error(traceback.format_exc())
            # Tentar limpar recursos em caso de falha ao iniciar/executar o loop
            client_tasks.pop(client_sid, None)
            client_audio_queues.pop(client_sid, None)
            client_sample_rates.pop(client_sid, None)
            client_vad_configs.pop(client_sid, None)
            socketio.emit('processing_error', {'error': f'Erro crítico no servidor ao iniciar sessão: {e}'}, room=client_sid)
        finally:
            if loop and not loop.is_closed():
                logger.debug(f"Fechando loop de eventos para {client_sid[:6]}.")
                # Fechar todas as tasks restantes no loop antes de fechar o loop
                for task in asyncio.all_tasks(loop):
                     if not task.done():
                         task.cancel()
                try:
                    # Dar chance para as tasks canceladas terminarem
                    loop.run_until_complete(asyncio.sleep(0.1))
                except Exception as sleep_err:
                     logger.warning(f"Erro durante sleep pós-cancelamento no loop de {client_sid[:6]}: {sleep_err}")

                loop.close()
                logger.info(f"Loop de eventos para {client_sid[:6]} fechado.")
            else:
                 logger.debug(f"Loop para {client_sid[:6]} já estava fechado ou não foi criado.")
            logger.info(f"Thread de background para {client_sid[:6]} finalizada.")


    # Iniciar a função `start_session_task_thread` em uma thread separada gerenciada pelo SocketIO
    socketio.start_background_task(start_session_task_thread)
    logger.info(f"Tarefa em background (start_session_task_thread) iniciada para {client_sid[:6]}")


@socketio.on('audio_input_chunk')
def handle_audio_input_chunk(data):
    """Processa um chunk de áudio recebido do cliente."""
    client_sid = request.sid
    audio_chunk_base64 = data.get('audio')

    # Validar dados recebidos
    if not audio_chunk_base64 or not isinstance(audio_chunk_base64, str):
        logger.warning(f"Recebido chunk de áudio inválido (vazio ou não string) de {client_sid[:6]}")
        return

    # Verificar se existe uma fila de áudio ativa para este cliente
    audio_queue = client_audio_queues.get(client_sid)
    if not audio_queue:
        # Isso pode acontecer se o cliente enviar áudio após desconectar ou antes de iniciar
        logger.warning(f"Recebido chunk de áudio de {client_sid[:6]}, mas não há fila/sessão ativa. Ignorando.")
        return

    # Obter taxa de amostragem original do cliente (deve existir se a fila existe)
    original_sample_rate = client_sample_rates.get(client_sid)
    if not original_sample_rate:
        logger.error(f"Recebido chunk de áudio de {client_sid[:6]}, mas a taxa de amostragem original não foi encontrada (erro de estado). Ignorando.")
        # Talvez desconectar o cliente ou emitir erro?
        return

    TARGET_SAMPLE_RATE = 16000  # Taxa requerida pela OpenAI para input PCM16
    TARGET_SAMPLE_WIDTH = 2 # PCM 16-bit = 2 bytes por amostra
    TARGET_CHANNELS = 1 # Mono

    try:
        # 1. Decodificar Base64 para bytes
        audio_bytes = base64.b64decode(audio_chunk_base64)
        if not audio_bytes:
            logger.warning(f"Chunk de áudio decodificado de {client_sid[:6]} está vazio.")
            return

        # 2. Converter bytes para um objeto AudioSegment do Pydub
        # Assumindo que o cliente envia PCM 16-bit, 1 canal (mono) - IMPORTANTE!
        # Se o cliente enviar outro formato (ex: float32, Ogg, Wav), esta parte falhará ou produzirá lixo.
        try:
            audio_segment = AudioSegment(
                data=audio_bytes,
                sample_width=TARGET_SAMPLE_WIDTH,  # Assumindo PCM 16-bit do cliente
                frame_rate=original_sample_rate,
                channels=TARGET_CHANNELS      # Assumindo Mono do cliente
            )
        except Exception as e:
            # Pode falhar se os dados não forem PCM16 válidos ou o tamanho for incorreto
            logger.error(f"Erro ao criar AudioSegment de {client_sid[:6]} (Taxa: {original_sample_rate}Hz, Bytes: {len(audio_bytes)}): {e}. Verifique o formato de áudio do cliente.")
            return # Ignora chunk inválido

        # 3. Realizar resampling para TARGET_SAMPLE_RATE se necessário
        if audio_segment.frame_rate != TARGET_SAMPLE_RATE:
            # logger.debug(f"Resampling áudio de {client_sid[:6]} de {original_sample_rate}Hz para {TARGET_SAMPLE_RATE}Hz")
            try:
                audio_segment = audio_segment.set_frame_rate(TARGET_SAMPLE_RATE)
            except Exception as e:
                logger.error(f"Erro ao fazer resampling de {original_sample_rate}Hz para {TARGET_SAMPLE_RATE}Hz para {client_sid[:6]}: {e}")
                return # Ignora chunk se resampling falhar

        # 4. Garantir que o áudio está em mono e PCM16 (pode ser redundante se as suposições acima estiverem corretas, mas seguro)
        if audio_segment.channels != TARGET_CHANNELS:
            # logger.warning(f"Áudio de {client_sid[:6]} não era mono, convertendo.")
            audio_segment = audio_segment.set_channels(TARGET_CHANNELS)
        if audio_segment.sample_width != TARGET_SAMPLE_WIDTH:
             # logger.warning(f"Áudio de {client_sid[:6]} não era 16-bit, convertendo.")
             audio_segment = audio_segment.set_sample_width(TARGET_SAMPLE_WIDTH)

        # 5. Obter os dados raw PCM (bytes) do segmento processado
        pcm_data = audio_segment.raw_data

        # 6. Codificar os dados PCM processados de volta para Base64
        resampled_audio_base64 = base64.b64encode(pcm_data).decode('utf-8')

        # 7. Adicionar o chunk processado (Base64) à fila asyncio para envio à OpenAI
        try:
            # Usar put_nowait para não bloquear a thread do SocketIO se a fila estiver cheia
            audio_queue.put_nowait(resampled_audio_base64)
            # logger.debug(f"Chunk processado adicionado à fila para {client_sid[:6]}")
        except asyncio.QueueFull:
            # Se a fila estiver cheia, significa que o sender não está consumindo rápido o suficiente
            # (pode ser problema de rede com OpenAI ou a API está lenta)
            logger.warning(f"Fila de áudio cheia para {client_sid[:6]}, chunk descartado. Considere aumentar o tamanho da fila ou verificar a conexão/performance da API.")
            # Poderia enviar um feedback para o cliente aqui?

    except base64.binascii.Error as e:
        logger.warning(f"Erro ao decodificar Base64 do chunk de áudio de {client_sid[:6]}: {e}. Chunk ignorado.")
    except Exception as e:
        logger.error(f"Erro inesperado ao processar chunk de áudio de {client_sid[:6]}: {type(e).__name__} - {e}")
        logger.error(traceback.format_exc())
        # Talvez emitir um erro para o cliente?


@socketio.on('stop_recording')
def handle_stop_recording():
    """Chamado quando o cliente para a gravação manualmente."""
    client_sid = request.sid
    logger.info(f"Cliente {client_sid[:6]} parou a gravação manualmente.")

    # Enviar sinal de término (None) para a fila de áudio.
    # Isso fará o sender parar de enviar áudio e enviar o 'stream_end' para a OpenAI.
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            audio_queue.put_nowait(None) # Sinaliza fim para o sender
            logger.info(f"Sinal de término (stop_recording) enviado para a fila de áudio de {client_sid[:6]}")
        except asyncio.QueueFull:
            logger.warning(f"Fila de áudio cheia ao tentar parar gravação (stop_recording) de {client_sid[:6]}.")
        except Exception as e:
            logger.error(f"Erro ao enviar sinal de término (stop_recording) para {client_sid[:6]}: {e}")
    else:
        logger.warning(f"Fila de áudio não encontrada ao parar gravação de {client_sid[:6]}. A sessão pode já ter terminado ou não iniciado.")

    # A API OpenAI detectará o fim da fala com base no VAD e/ou no evento 'stream_end'
    # que o sender enviará após receber o 'None'.

# --- Inicialização da Aplicação ---

if __name__ == "__main__":
    print("==========================================")
    print("=== Assistente de Voz OpenAI Realtime ===")
    print("==========================================")
    initialize_env() # Carrega variáveis de ambiente (OPENAI_API_KEY) e faz a validação inicial

    # Obter porta e host do ambiente ou usar padrões
    port = int(os.environ.get("PORT", 5001)) # Usar porta diferente de 5000 se Flask padrão já usar
    host = os.environ.get("HOST", "0.0.0.0") # 0.0.0.0 permite conexões de outras máquinas na rede

    print(f"\nServidor Flask-SocketIO pronto.")
    print(f"Abra o arquivo 'index.html' em seu navegador.")
    print(f"Servindo em http://{host}:{port}")
    print("Pressione CTRL+C para parar o servidor.")
    print("==========================================")


    # Iniciar o servidor SocketIO
    # debug=False e allow_unsafe_werkzeug=True são recomendados para evitar o erro de produção do Werkzeug
    # use_reloader=False é importante quando se usa threads/asyncio
    socketio.run(app,
                 host=host,
                 port=port,
                 debug=False, # Mantenha False para um ambiente mais estável
                 use_reloader=False,
                 allow_unsafe_werkzeug=True # Necessário quando debug=False
                 )