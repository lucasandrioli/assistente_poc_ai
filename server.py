# server.py - Servidor otimizado para Assistente de Voz OpenAI Realtime
import os
import sys
import base64
import asyncio
import traceback
import json
import logging
import io
import threading
import queue
from typing import Dict, Optional, Any
from datetime import datetime

import websockets
import numpy as np
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
CORS(app)
compress = Compress(app)

# Configurações para WebSocket
SOCKET_PING_TIMEOUT = 5  # Segundos para timeout de ping
SOCKET_PING_INTERVAL = 3  # Intervalo entre pings em segundos

# Inicialização do SocketIO
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='threading',
    logger=False,
    engineio_logger=False,
    ping_timeout=SOCKET_PING_TIMEOUT,
    ping_interval=SOCKET_PING_INTERVAL,
    max_http_buffer_size=5*1024*1024,  # Aumentar buffer para transferência mais rápida
)

# Variáveis globais
openai_api_key = None
client_tasks: Dict[str, asyncio.Task] = {}
client_audio_queues: Dict[str, asyncio.Queue] = {}
client_sample_rates: Dict[str, int] = {}
initialization_done = False
OPENAI_MODEL = "gpt-4o-mini-realtime-preview"  # Modelo para streaming de áudio em tempo real

# Rota raiz para servir a página HTML
@app.route('/')
def index():
    """Serve o arquivo index.html principal."""
    return send_from_directory('.', 'index.html')

# Rotas para servir arquivos estáticos
@app.route('/<path:path>')
def serve_static(path):
    """Serve outros arquivos estáticos (CSS, JS, etc.)."""
    return send_from_directory('.', path)

def initialize_env():
    """Inicializa variáveis de ambiente e configurações globais."""
    global openai_api_key, initialization_done

    if initialization_done:
        return

    logger.info("Inicializando configurações do servidor...")

    # Verificar chave API OpenAI
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key:
        logger.critical("ERRO FATAL: OPENAI_API_KEY não definida no ambiente")
        sys.exit(1)
    else:
        # Mascarar a chave para o log
        masked_key = openai_api_key[:5] + "*" * 10 + openai_api_key[-5:] if len(openai_api_key) > 20 else "*" * len(openai_api_key)
        logger.info(f"OpenAI API Key configurada: {masked_key}")

    initialization_done = True
    logger.info("Inicialização concluída com sucesso!")

async def openai_sender(client_sid: str, ws: websockets.WebSocketClientProtocol, audio_queue: asyncio.Queue):
    """Envia chunks de áudio da fila para a API OpenAI via WebSocket."""
    logger.info(f"[Sender {client_sid[:6]}] Iniciado. Aguardando chunks de áudio...")

    try:
        while True:
            # Aguardar dados na fila com timeout para evitar bloqueio infinito
            try:
                audio_chunk_base64 = await asyncio.wait_for(audio_queue.get(), timeout=10.0)

                # 'None' na fila é o sinal para encerrar esta task
                if audio_chunk_base64 is None:
                    logger.info(f"[Sender {client_sid[:6]}] Recebido sinal de encerramento")
                    break

                # Preparar e enviar o evento de áudio para a OpenAI
                audio_event = {
                    "type": "input_audio_buffer.append",
                    "audio": audio_chunk_base64
                }

                await asyncio.wait_for(
                    ws.send(json.dumps(audio_event)),
                    timeout=5.0 # Timeout para envio
                )

                audio_queue.task_done() # Marcar item como processado na fila

            except asyncio.TimeoutError:
                # Timeout ao esperar item na fila ou ao enviar
                if ws.closed:
                    logger.warning(f"[Sender {client_sid[:6]}] Timeout e WebSocket já estava fechado. Encerrando.")
                    break
                # Se o WebSocket ainda estiver aberto, apenas continua esperando
                logger.debug(f"[Sender {client_sid[:6]}] Timeout na fila, continuando...")
                continue

            except websockets.exceptions.ConnectionClosed:
                logger.warning(f"[Sender {client_sid[:6]}] Conexão com OpenAI fechada inesperadamente.")
                break

            except Exception as e:
                logger.error(f"[Sender {client_sid[:6]}] Erro inesperado ao enviar chunk: {e}")
                logger.error(traceback.format_exc())
                break

    finally:
        logger.info(f"[Sender {client_sid[:6]}] Finalizado.")

# CORREÇÃO: Função movida para fora do `openai_sender`
async def openai_receiver(client_sid: str, ws: websockets.WebSocketClientProtocol):
    """Recebe eventos e áudio da API OpenAI e repassa para o cliente via Socket.IO."""
    logger.info(f"[Receiver {client_sid[:6]}] Iniciado. Aguardando eventos da OpenAI...")

    # Indicadores para a interface
    processing_started = False # Flag para saber se já notificamos o início do processamento

    try:
        while True:
            try:
                # Aguardar mensagem da OpenAI com timeout
                message_str = await asyncio.wait_for(ws.recv(), timeout=60.0) # Timeout longo para esperar resposta
                server_event = json.loads(message_str)
                event_type = server_event.get("type")

                # Log diferenciado para eventos frequentes (delta)
                if event_type in ["response.audio.delta", "response.text.delta"]:
                    logger.debug(f"[Receiver {client_sid[:6]}] Evento recebido: {event_type}")
                else:
                    logger.info(f"[Receiver {client_sid[:6]}] Evento recebido: {event_type}")

                # --- Processamento otimizado para baixa latência ---

                # Detecção de fim de fala pela API
                if event_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[Receiver {client_sid[:6]}] API detectou fim da fala do usuário.")
                    socketio.emit('speech_stopped', {}, room=client_sid) # Notifica cliente

                    # Notificar cliente que o processamento da IA começou (se ainda não notificou)
                    if not processing_started:
                        socketio.emit('processing_started', {}, room=client_sid)
                        processing_started = True

                # Chunk de áudio da resposta da IA
                elif event_type == "response.audio.delta":
                    audio_chunk_base64 = server_event.get("delta")
                    if audio_chunk_base64:
                        # Envio IMEDIATO para o cliente
                        socketio.emit('audio_chunk', {'audio': audio_chunk_base64}, room=client_sid)

                # Chunk de texto da resposta da IA
                elif event_type == "response.text.delta":
                    text_chunk = server_event.get("delta")
                    if text_chunk:
                        # Envio IMEDIATO para o cliente
                        socketio.emit('text_chunk', {'text': text_chunk}, room=client_sid)

                # Detecção de início de fala pela API
                elif event_type == "input_audio_buffer.speech_started":
                    logger.info(f"[Receiver {client_sid[:6]}] API detectou início da fala do usuário.")
                    socketio.emit('speech_started', {}, room=client_sid) # Notifica cliente
                    processing_started = False # Reseta flag de processamento

                # Início da resposta da IA (sinal para feedback visual)
                elif event_type == "response.created" or event_type == "response.output_item.added":
                    logger.info(f"[Receiver {client_sid[:6]}] API iniciou a criação da resposta.")
                    socketio.emit('response_starting', {}, room=client_sid) # Notifica cliente

                # Fim da resposta da IA
                elif event_type == "response.done":
                    logger.info(f"[Receiver {client_sid[:6]}] API finalizou a resposta.")
                    socketio.emit('audio_stream_end', {}, room=client_sid) # Notifica cliente
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

            except asyncio.TimeoutError:
                logger.warning(f"[Receiver {client_sid[:6]}] Timeout ao aguardar mensagem da OpenAI. Encerrando.")
                socketio.emit('processing_error', {'error': 'Timeout na comunicação com a API OpenAI'}, room=client_sid)
                break

            except websockets.exceptions.ConnectionClosedOK:
                logger.info(f"[Receiver {client_sid[:6]}] Conexão com OpenAI fechada normalmente.")
                break

            except websockets.exceptions.ConnectionClosedError as e:
                logger.error(f"[Receiver {client_sid[:6]}] Conexão com OpenAI fechada com erro: {e}")
                socketio.emit('processing_error', {'error': 'Conexão perdida com a API OpenAI'}, room=client_sid)
                break

            except json.JSONDecodeError as e:
                logger.error(f"[Receiver {client_sid[:6]}] Erro ao decodificar JSON da OpenAI: {e} - Mensagem: {message_str}")
                # Continua tentando receber, pode ter sido uma mensagem malformada isolada

            except Exception as e:
                logger.error(f"[Receiver {client_sid[:6]}] Erro inesperado ao receber/processar evento: {e}")
                logger.error(traceback.format_exc())
                socketio.emit('processing_error', {'error': f'Erro interno no servidor: {e}'}, room=client_sid)
                break

    finally:
        # Garantir que o evento de fim de stream seja enviado ao cliente, mesmo se ocorrer erro
        # Verifica se o cliente ainda está conectado antes de emitir
        if client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set()):
             logger.info(f"[Receiver {client_sid[:6]}] Garantindo envio de 'audio_stream_end'.")
             socketio.emit('audio_stream_end', {}, room=client_sid)
        else:
             logger.info(f"[Receiver {client_sid[:6]}] Cliente já desconectado, não enviando 'audio_stream_end'.")
        logger.info(f"[Receiver {client_sid[:6]}] Finalizado.")


async def manage_openai_session(client_sid: str, audio_queue: asyncio.Queue):
    """Gerencia a conexão WebSocket completa com a API OpenAI para um cliente."""
    global openai_api_key

    logger.info(f"[Manager {client_sid[:6]}] Iniciando sessão OpenAI...")

    # Verificar se a chave API está configurada (deve estar, mas é uma checagem extra)
    if not openai_api_key:
        logger.error(f"[Manager {client_sid[:6]}] Chave API OpenAI não configurada ao iniciar sessão.")
        socketio.emit('processing_error', {'error': 'Chave API OpenAI não configurada no servidor'}, room=client_sid)
        return

    # Configurações da API
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
        ws = await asyncio.wait_for(
            websockets.connect(OPENAI_WEBSOCKET_URI, extra_headers=headers),
            timeout=10.0 # Timeout para conexão inicial
        )
        logger.info(f"[Manager {client_sid[:6]}] Conectado à API OpenAI.")

        # 2. Configurar a sessão (formato de áudio, VAD, instruções, voz)
        logger.info(f"[Manager {client_sid[:6]}] Configurando sessão (Formato: PCM16@{TARGET_INPUT_RATE}Hz, VAD, Instruções)...")
        audio_config = {
            "type": "session.update",
            "session": {
                "input_audio_format": "pcm16", # Formato esperado pela API
                "turn_detection": {
                    "type": "server_vad", # Usar VAD (Voice Activity Detection) do servidor OpenAI
                    "threshold": 0.15,       # Sensibilidade VAD (menor = mais sensível) - Ajustado para baixa latência
                    "silence_duration_ms": 50, # Tempo de silêncio para fim de fala (baixo = rápido) - Ajustado
                    "prefix_padding_ms": 1,  # Pequeno padding antes da fala - Ajustado
                    "create_response": True,   # Gerar resposta automaticamente após fim de fala
                    "interrupt_response": True # Permitir interrupção da resposta
                },
                # Instruções para o modelo (importante para o comportamento)
                "instructions": "Você é um assistente em português do Brasil. Responda sempre em português brasileiro com sotaque neutro. Seja extremamente conciso e breve. Limite suas respostas a uma ou duas frases curtas. Priorize velocidade sobre detalhes.",
                "voice": "nova" # Voz da OpenAI (outras opções: alloy, echo, fable, onyx, shimmer) - 'nova' pode ser mais rápida
            }
        }
        await asyncio.wait_for(
            ws.send(json.dumps(audio_config)),
            timeout=5.0 # Timeout para enviar configuração
        )
        logger.info(f"[Manager {client_sid[:6]}] Configuração da sessão enviada.")

        # 3. Iniciar tasks de envio (sender) e recebimento (receiver) em paralelo
        logger.info(f"[Manager {client_sid[:6]}] Iniciando tasks de envio e recebimento...")
        sender_task = asyncio.create_task(
            openai_sender(client_sid, ws, audio_queue),
            name=f"Sender_{client_sid[:6]}"
        )
        receiver_task = asyncio.create_task(
            openai_receiver(client_sid, ws),
            name=f"Receiver_{client_sid[:6]}"
        )

        # Armazenar a tarefa principal para possível cancelamento externo
        client_tasks[client_sid] = asyncio.current_task()

        # 4. Aguardar a conclusão da primeira tarefa (sender ou receiver)
        # Se uma delas terminar (por erro, desconexão, etc.), a outra deve ser cancelada.
        done, pending = await asyncio.wait(
            [sender_task, receiver_task],
            return_when=asyncio.FIRST_COMPLETED
        )

        # 5. Lidar com tarefas concluídas e pendentes
        for task in done:
            try:
                # Verificar se a tarefa concluída gerou alguma exceção
                task.result()
                logger.info(f"[Manager {client_sid[:6]}] Tarefa {task.get_name()} concluída sem erros.")
            except Exception as e:
                # Logar exceção da tarefa concluída (pode ser CancelledError ou outro erro)
                 if not isinstance(e, asyncio.CancelledError):
                    logger.warning(f"[Manager {client_sid[:6]}] Tarefa {task.get_name()} concluída com erro: {type(e).__name__}")


        logger.info(f"[Manager {client_sid[:6]}] Uma das tasks (sender/receiver) terminou. Cancelando a outra...")
        for task in pending:
            logger.info(f"[Manager {client_sid[:6]}] Cancelando tarefa pendente: {task.get_name()}")
            task.cancel()
            try:
                await task # Aguardar o cancelamento efetivo
            except asyncio.CancelledError:
                logger.info(f"[Manager {client_sid[:6]}] Tarefa {task.get_name()} cancelada com sucesso.")
            except Exception as e:
                logger.error(f"[Manager {client_sid[:6]}] Erro durante o cancelamento da tarefa {task.get_name()}: {e}")

    except websockets.exceptions.InvalidURI:
         logger.critical(f"[Manager {client_sid[:6]}] URI inválida para WebSocket OpenAI: {OPENAI_WEBSOCKET_URI}")
         socketio.emit('processing_error', {'error': 'Configuração inválida do servidor OpenAI'}, room=client_sid)
    except websockets.exceptions.WebSocketException as e:
         logger.error(f"[Manager {client_sid[:6]}] Erro de WebSocket ao conectar/configurar: {e}")
         socketio.emit('processing_error', {'error': f'Erro de comunicação com OpenAI: {e}'}, room=client_sid)
    except asyncio.TimeoutError:
        logger.error(f"[Manager {client_sid[:6]}] Timeout ao conectar ou configurar a sessão OpenAI.")
        socketio.emit('processing_error', {'error': 'Timeout ao iniciar comunicação com OpenAI'}, room=client_sid)
    except Exception as e:
        logger.error(f"[Manager {client_sid[:6]}] Erro inesperado na gestão da sessão OpenAI: {type(e).__name__}: {e}")
        logger.error(traceback.format_exc())
        socketio.emit('processing_error', {'error': f'Erro interno do servidor: {e}'}, room=client_sid)

    finally:
        # --- Limpeza de recursos ---
        logger.info(f"[Manager {client_sid[:6]}] Finalizando sessão e liberando recursos...")

        # Garantir cancelamento das tasks se ainda estiverem ativas
        if sender_task and not sender_task.done():
            logger.info(f"[Manager {client_sid[:6]}] Cancelando sender_task na limpeza final.")
            sender_task.cancel()
        if receiver_task and not receiver_task.done():
            logger.info(f"[Manager {client_sid[:6]}] Cancelando receiver_task na limpeza final.")
            receiver_task.cancel()

        # Fechar conexão WebSocket se estiver aberta
        if ws and not ws.closed:
            logger.info(f"[Manager {client_sid[:6]}] Fechando conexão WebSocket com OpenAI...")
            try:
                await ws.close()
                logger.info(f"[Manager {client_sid[:6]}] Conexão WebSocket fechada.")
            except Exception as e:
                logger.warning(f"[Manager {client_sid[:6]}] Erro ao fechar WebSocket na limpeza: {e}")

        # Remover referências das estruturas globais
        client_tasks.pop(client_sid, None)
        client_audio_queues.pop(client_sid, None)
        client_sample_rates.pop(client_sid, None)

        # Enviar sinal de fim ao cliente (se ainda conectado)
        if client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set()):
            logger.info(f"[Manager {client_sid[:6]}] Enviando 'audio_stream_end' final para o cliente.")
            socketio.emit('audio_stream_end', {}, room=client_sid)

        logger.info(f"[Manager {client_sid[:6]}] Sessão OpenAI finalizada e recursos liberados.")


# -------------------------------------
# Handlers de Eventos Socket.IO
# -------------------------------------

@socketio.on('connect')
def handle_connect():
    """Chamado quando um novo cliente se conecta via Socket.IO."""
    client_sid = request.sid
    logger.info(f"Cliente conectado: {client_sid[:6]}")

    # Certificar que as variáveis de ambiente foram inicializadas
    if not initialization_done:
        initialize_env()

    # Verificar se a chave API está disponível (após inicialização)
    if not openai_api_key:
        logger.error("Tentativa de conexão falhou: Chave API OpenAI não configurada no servidor.")
        emit('processing_error', {'error': 'API OpenAI não configurada no servidor. Contate o administrador.'})
        # Considerar desconectar o cliente aqui se a chave for essencial
        # disconnect()

@socketio.on('disconnect')
def handle_disconnect():
    """Chamado quando um cliente se desconecta."""
    client_sid = request.sid
    logger.info(f"Cliente desconectado: {client_sid[:6]}")

    # Sinalizar para a task `openai_sender` que ela deve terminar
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            # Colocar 'None' na fila sinaliza o fim
            audio_queue.put_nowait(None)
            logger.info(f"Sinal de término (None) enviado para a fila de áudio de {client_sid[:6]}")
        except queue.Full:
             logger.warning(f"Fila de áudio cheia ao tentar enviar sinal de término para {client_sid[:6]}. A task pode demorar a parar.")
        except Exception as e:
            logger.warning(f"Erro ao enviar sinal de término para a fila de {client_sid[:6]}: {e}")

    # Limpar dados associados ao cliente (a task `manage_openai_session` também faz isso, mas garantimos aqui)
    client_sample_rates.pop(client_sid, None)
    # A remoção de client_tasks e client_audio_queues é feita no finally de manage_openai_session

@socketio.on('interrupt_response')
def handle_interrupt(data=None):
    """Chamado quando o cliente solicita interrupção da resposta da IA."""
    client_sid = request.sid
    logger.info(f"Cliente {client_sid[:6]} solicitou interrupção da resposta.")

    # Enviar sinal de término para a fila de áudio (interrompe o envio para a API)
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            audio_queue.put_nowait(None) # Sinaliza fim para o sender
            logger.info(f"Sinal de término (interrupção) enviado para a fila de {client_sid[:6]}")

            # Notificar o cliente que a interrupção foi recebida e cancelamento iniciado
            # O cancelamento real ocorre na API e o fim do stream será enviado pelo receiver
            socketio.emit('response_canceled', {}, room=client_sid)

        except queue.Full:
             logger.warning(f"Fila de áudio cheia ao tentar interromper {client_sid[:6]}.")
        except Exception as e:
            logger.error(f"Erro ao enviar sinal de término para interrupção de {client_sid[:6]}: {e}")
    else:
        logger.warning(f"Fila de áudio não encontrada para interrupção de {client_sid[:6]}. A sessão pode já ter terminado.")
        # Mesmo sem fila, notificar o cliente que o pedido foi recebido
        socketio.emit('response_canceled', {}, room=client_sid)

    # O cancelamento da resposta na API OpenAI é solicitado na configuração "interrupt_response": True
    # e a API enviará eventos indicando o fim do áudio/texto.

@socketio.on('start_recording')
def handle_start_recording(data):
    """Chamado quando o cliente inicia a gravação de áudio."""
    client_sid = request.sid
    client_sample_rate = data.get('sampleRate')

    if not client_sample_rate:
        logger.error(f"Cliente {client_sid[:6]} iniciou gravação sem informar sampleRate.")
        emit('processing_error', {'error': 'Taxa de amostragem não informada.'}, room=client_sid)
        return

    logger.info(f"Cliente {client_sid[:6]} iniciou gravação (Taxa: {client_sample_rate}Hz)")

    # Armazenar taxa de amostragem original do cliente
    client_sample_rates[client_sid] = client_sample_rate

    # Função interna para iniciar a tarefa asyncio em uma thread separada
    def start_session_task():
        logger.info(f"Iniciando task de gerenciamento de sessão para {client_sid[:6]} em background thread.")

        # Verificar se já existe uma tarefa ativa para este cliente (evita duplicação)
        if client_sid in client_tasks and not client_tasks[client_sid].done():
            logger.warning(f"Tentativa de iniciar nova gravação para {client_sid[:6]} enquanto uma sessão já está ativa.")
            # Poderia emitir um erro para o cliente aqui
            return

        # Verificar novamente a chave API (deve estar ok, mas por segurança)
        if not openai_api_key:
            logger.error(f"Chave API OpenAI não configurada ao iniciar task para {client_sid[:6]}")
            socketio.emit('processing_error', {'error': 'Chave API OpenAI não configurada no servidor'}, room=client_sid)
            return

        # Criar uma nova fila de áudio para esta sessão
        audio_queue = asyncio.Queue()
        client_audio_queues[client_sid] = audio_queue

        # Função wrapper para rodar a corrotina principal em um novo loop de eventos
        async def run_main_task():
            # Cria e agenda a corrotina principal que gerencia a sessão
            task = asyncio.create_task(
                manage_openai_session(client_sid, audio_queue),
                name=f"Manager_{client_sid[:6]}"
            )
            client_tasks[client_sid] = task # Armazena a referência da task
            logger.info(f"Task {task.get_name()} criada e agendada.")

            try:
                await task # Aguarda a conclusão da task (ou erro)
                logger.info(f"Task {task.get_name()} concluída.")
            except asyncio.CancelledError:
                logger.info(f"Task {task.get_name()} foi cancelada externamente.")
            except Exception as e:
                 logger.error(f"Task {task.get_name()} falhou com exceção: {type(e).__name__}")
            finally:
                # Limpeza final (redundante com o finally de manage_openai_session, mas seguro)
                logger.info(f"Limpeza final na thread para task {task.get_name()}.")
                client_tasks.pop(client_sid, None)
                client_audio_queues.pop(client_sid, None)
                client_sample_rates.pop(client_sid, None)


        # Executar a função wrapper assíncrona
        try:
            # Obter ou criar um loop de eventos para esta thread
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(run_main_task())
            loop.close()
            logger.info(f"Loop de eventos para {client_sid[:6]} finalizado.")
        except Exception as e:
            logger.error(f"Erro ao executar o loop de eventos para {client_sid[:6]}: {e}")
            logger.error(traceback.format_exc())
            # Limpar em caso de falha ao iniciar o loop
            client_tasks.pop(client_sid, None)
            client_audio_queues.pop(client_sid, None)
            client_sample_rates.pop(client_sid, None)


    # Iniciar a função `start_session_task` em uma thread separada gerenciada pelo SocketIO
    socketio.start_background_task(start_session_task)
    logger.info(f"Tarefa em background iniciada para {client_sid[:6]}")


@socketio.on('audio_input_chunk')
def handle_audio_input_chunk(data):
    """Processa um chunk de áudio recebido do cliente."""
    client_sid = request.sid
    audio_chunk_base64 = data.get('audio')

    # Validar dados recebidos
    if not audio_chunk_base64:
        logger.warning(f"Recebido chunk de áudio vazio de {client_sid[:6]}")
        return

    # Verificar se existe uma fila de áudio ativa para este cliente
    audio_queue = client_audio_queues.get(client_sid)
    if not audio_queue:
        logger.warning(f"Recebido chunk de áudio de {client_sid[:6]}, mas não há fila ativa (sessão pode ter terminado).")
        return

    # Obter taxa de amostragem original do cliente
    original_sample_rate = client_sample_rates.get(client_sid)
    if not original_sample_rate:
         logger.warning(f"Recebido chunk de áudio de {client_sid[:6]}, mas a taxa de amostragem original não foi encontrada.")
         return

    TARGET_SAMPLE_RATE = 16000  # Taxa requerida pela OpenAI

    try:
        # 1. Decodificar Base64 para bytes
        audio_bytes = base64.b64decode(audio_chunk_base64)
        if not audio_bytes:
            logger.warning(f"Chunk de áudio decodificado de {client_sid[:6]} está vazio.")
            return

        # 2. Converter bytes para um objeto AudioSegment do Pydub
        # Assumindo que o cliente envia PCM 16-bit, 1 canal (mono)
        try:
            audio_segment = AudioSegment(
                data=audio_bytes,
                sample_width=2,  # PCM 16-bit = 2 bytes por amostra
                frame_rate=original_sample_rate,
                channels=1       # Mono
            )
        except Exception as e:
            # Pode falhar se os dados não forem PCM válidos
            logger.error(f"Erro ao criar AudioSegment de {client_sid[:6]} (Taxa: {original_sample_rate}Hz): {e}")
            return # Ignora chunk inválido

        # 3. Realizar resampling para TARGET_SAMPLE_RATE se necessário
        if audio_segment.frame_rate != TARGET_SAMPLE_RATE:
            try:
                audio_segment = audio_segment.set_frame_rate(TARGET_SAMPLE_RATE)
            except Exception as e:
                 logger.error(f"Erro ao fazer resampling de {original_sample_rate}Hz para {TARGET_SAMPLE_RATE}Hz para {client_sid[:6]}: {e}")
                 return # Ignora chunk se resampling falhar

        # 4. Garantir que o áudio está em mono e PCM16 (pode ser redundante, mas seguro)
        audio_segment = audio_segment.set_channels(1)
        audio_segment = audio_segment.set_sample_width(2)

        # 5. Obter os dados raw PCM (bytes) do segmento processado
        pcm_data = audio_segment.raw_data

        # 6. Codificar os dados PCM processados de volta para Base64
        resampled_audio_base64 = base64.b64encode(pcm_data).decode('utf-8')

        # 7. Adicionar o chunk processado à fila para envio à OpenAI
        try:
            audio_queue.put_nowait(resampled_audio_base64)
        except queue.Full:
            logger.warning(f"Fila de áudio cheia para {client_sid[:6]}, chunk descartado.")

    except base64.binascii.Error as e:
         logger.warning(f"Erro ao decodificar Base64 de {client_sid[:6]}: {e}")
    except Exception as e:
        logger.error(f"Erro inesperado ao processar chunk de áudio de {client_sid[:6]}: {e}")
        logger.error(traceback.format_exc())

@socketio.on('stop_recording')
def handle_stop_recording():
    """Chamado quando o cliente para a gravação."""
    client_sid = request.sid
    logger.info(f"Cliente {client_sid[:6]} parou a gravação.")

    # Enviar sinal de término para a fila de áudio (interrompe o envio para a API)
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            audio_queue.put_nowait(None) # Sinaliza fim para o sender
            logger.info(f"Sinal de término (stop_recording) enviado para a fila de {client_sid[:6]}")
        except queue.Full:
             logger.warning(f"Fila de áudio cheia ao tentar parar gravação de {client_sid[:6]}.")
        except Exception as e:
            logger.error(f"Erro ao enviar sinal de término (stop_recording) para {client_sid[:6]}: {e}")
    else:
        logger.warning(f"Fila de áudio não encontrada ao parar gravação de {client_sid[:6]}. A sessão pode já ter terminado.")

    # A API OpenAI detectará o fim da fala com base no VAD e no sinal de término implícito
    # quando o sender parar de enviar dados após o 'None'.

# Inicialização da aplicação Flask/SocketIO
if __name__ == "__main__":
    print("==========================================")
    print("=== Assistente de Voz OpenAI Realtime ===")
    print("==========================================")
    initialize_env() # Carrega variáveis de ambiente (OPENAI_API_KEY)

    # Obter porta e host do ambiente ou usar padrões
    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("HOST", "0.0.0.0") # 0.0.0.0 permite conexões externas

    print(f"\nServidor pronto para aceitar conexões em http://{host}:{port}")
    print("Pressione CTRL+C para parar o servidor.")

    # Iniciar o servidor SocketIO
    # debug=True habilita logs detalhados e recarregamento automático (útil para desenvolvimento)
    # use_reloader=False é importante quando se usa threads/asyncio para evitar problemas
    # allow_unsafe_werkzeug=True é necessário para versões mais recentes do Flask/Werkzeug com debug=True
    socketio.run(app,
                 host=host,
                 port=port,
                 debug=True, # Mude para False em produção
                 use_reloader=False,
                 allow_unsafe_werkzeug=True)
