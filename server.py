# server.py - Servidor corrigido para Assistente de Voz OpenAI Realtime
import os
import sys
import base64
import asyncio
import traceback
import json
import logging
import io
import threading
from typing import Dict, Optional, Any
from datetime import datetime

import websockets
import numpy as np
from pydub import AudioSegment
from flask import Flask, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, emit
import colorlog

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
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', 
                   logger=False, engineio_logger=False)

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
    return send_from_directory('.', 'index.html')

# Rotas para servir arquivos estáticos
@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

def initialize_env():
    """Inicializa variáveis de ambiente e configurações globais"""
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
        masked_key = openai_api_key[:5] + "*" * 10 + openai_api_key[-5:] if len(openai_api_key) > 20 else "*" * len(openai_api_key)
        logger.info(f"OpenAI API Key configurada: {masked_key}")
    
    initialization_done = True
    logger.info("Inicialização concluída com sucesso!")

async def openai_sender(client_sid: str, ws: websockets.WebSocketClientProtocol, audio_queue: asyncio.Queue):
    """Envia chunks de áudio para a API OpenAI via WebSocket"""
    logger.info(f"[Sender {client_sid[:6]}] Iniciado. Aguardando chunks de áudio...")
    
    try:
        while True:
            # Aguardar dados na fila com timeout para evitar bloqueio infinito
            try:
                audio_chunk_base64 = await asyncio.wait_for(audio_queue.get(), timeout=10.0)
                
                # None é sinal para encerrar
                if audio_chunk_base64 is None:
                    logger.info(f"[Sender {client_sid[:6]}] Recebido sinal de encerramento")
                    break
                
                # Enviar chunk para OpenAI
                audio_event = {
                    "type": "input_audio_buffer.append", 
                    "audio": audio_chunk_base64
                }
                
                await asyncio.wait_for(
                    ws.send(json.dumps(audio_event)), 
                    timeout=5.0
                )
                
                audio_queue.task_done()
                
            except asyncio.TimeoutError:
                # Se o WebSocket já estiver fechado, encerrar
                if ws.closed:
                    logger.warning(f"[Sender {client_sid[:6]}] Timeout na fila e WebSocket fechado")
                    break
                continue
                
            except websockets.exceptions.ConnectionClosed:
                logger.warning(f"[Sender {client_sid[:6]}] Conexão com OpenAI fechada")
                break
                
            except Exception as e:
                logger.error(f"[Sender {client_sid[:6]}] Erro ao enviar chunk: {e}")
                break
    
    finally:
        logger.info(f"[Sender {client_sid[:6]}] Finalizado")

async def openai_receiver(client_sid: str, ws: websockets.WebSocketClientProtocol):
    """Recebe eventos e áudio da API OpenAI e repassa para o cliente"""
    logger.info(f"[Receiver {client_sid[:6]}] Iniciado. Aguardando eventos da OpenAI...")
    
    try:
        while True:
            try:
                # Aguardar mensagem com timeout
                message_str = await asyncio.wait_for(ws.recv(), timeout=60.0)
                server_event = json.loads(message_str)
                event_type = server_event.get("type")
                
                # Log com nível apropriado baseado no tipo de evento
                if event_type in ["response.audio.delta", "response.text.delta"]:
                    logger.debug(f"[Receiver {client_sid[:6]}] Evento: {event_type}")
                else:
                    logger.info(f"[Receiver {client_sid[:6]}] Evento: {event_type}")
                
                # Processar diferentes tipos de eventos
                if event_type == "response.audio.delta":
                    # Chunks de áudio
                    audio_chunk_base64 = server_event.get("delta")
                    if audio_chunk_base64:
                        socketio.emit('audio_chunk', {'audio': audio_chunk_base64}, room=client_sid)
                    else:
                        logger.warning(f"[Receiver {client_sid[:6]}] Evento audio.delta sem conteúdo")
                
                elif event_type == "response.text.delta":
                    # Chunks de texto
                    text_chunk = server_event.get("delta")
                    if text_chunk:
                        socketio.emit('text_chunk', {'text': text_chunk}, room=client_sid)
                
                elif event_type == "response.done":
                    # Fim da resposta
                    logger.info(f"[Receiver {client_sid[:6]}] Resposta finalizada")
                    socketio.emit('audio_stream_end', {}, room=client_sid)
                
                elif event_type == "input_audio_buffer.speech_started":
                    logger.info(f"[Receiver {client_sid[:6]}] Detecção de fala iniciada")
                    socketio.emit('speech_started', {}, room=client_sid)
                
                elif event_type == "input_audio_buffer.speech_stopped":
                    logger.info(f"[Receiver {client_sid[:6]}] Detecção de fala finalizada")
                    socketio.emit('speech_stopped', {}, room=client_sid)
                
                elif "error" in str(event_type).lower() or event_type == "error":
                    # Erros da API
                    error_details = server_event.get("message", str(server_event))
                    logger.error(f"[Receiver {client_sid[:6]}] ERRO API OpenAI: {error_details}")
                    socketio.emit(
                        'processing_error', 
                        {'error': f'Erro API OpenAI: {error_details}'}, 
                        room=client_sid
                    )
                    break
            
            except asyncio.TimeoutError:
                logger.warning(f"[Receiver {client_sid[:6]}] Timeout ao aguardar resposta OpenAI")
                socketio.emit('processing_error', {'error': 'Timeout na comunicação com a API'}, room=client_sid)
                break
                
            except websockets.exceptions.ConnectionClosedOK:
                logger.info(f"[Receiver {client_sid[:6]}] Conexão OpenAI fechada (OK)")
                break
                
            except websockets.exceptions.ConnectionClosedError as e:
                logger.error(f"[Receiver {client_sid[:6]}] Conexão OpenAI fechada com erro: {e}")
                socketio.emit('processing_error', {'error': 'Conexão perdida com API OpenAI'}, room=client_sid)
                break
                
            except Exception as e:
                logger.error(f"[Receiver {client_sid[:6]}] Erro inesperado: {e}")
                logger.error(traceback.format_exc())
                socketio.emit('processing_error', {'error': f'Erro de comunicação: {e}'}, room=client_sid)
                break
    
    finally:
        # Garantir que o evento de fim seja enviado
        if client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set()):
            socketio.emit('audio_stream_end', {}, room=client_sid)
        logger.info(f"[Receiver {client_sid[:6]}] Finalizado")

async def manage_openai_session(client_sid: str, audio_queue: asyncio.Queue):
    """Gerencia a sessão completa com a API OpenAI para um cliente"""
    global openai_api_key
    
    logger.info(f"[Manager {client_sid[:6]}] Iniciando sessão OpenAI...")
    
    # Verificar se a chave API está configurada
    if not openai_api_key:
        logger.error(f"[Manager {client_sid[:6]}] Chave API não configurada")
        socketio.emit('processing_error', {'error': 'Chave API OpenAI não configurada'}, room=client_sid)
        return
    
    # Configuração
    TARGET_INPUT_RATE = 16000  # Taxa de amostragem exigida pela OpenAI
    OPENAI_WEBSOCKET_URI = f"wss://api.openai.com/v1/realtime?model={OPENAI_MODEL}"
    headers = {
        "Authorization": f"Bearer {openai_api_key}",
        "OpenAI-Beta": "realtime=v1"
    }
    
    ws = None
    sender_task = None
    receiver_task = None
    
    try:
        # Conectar ao WebSocket da OpenAI
        logger.info(f"[Manager {client_sid[:6]}] Conectando a API OpenAI...")
        ws = await asyncio.wait_for(
            websockets.connect(OPENAI_WEBSOCKET_URI, extra_headers=headers), 
            timeout=10.0
        )
        
        # Aguardar a criação da sessão
        logger.info(f"[Manager {client_sid[:6]}] Conectado! Aguardando criação da sessão...")
        session_ready = False
        session_id = None
        
        try:
            # Loop para aguardar o evento de sessão criada
            start_time = datetime.now()
            while (datetime.now() - start_time).total_seconds() < 10:  # Timeout de 10 segundos
                message_str = await asyncio.wait_for(ws.recv(), timeout=5.0)
                server_event = json.loads(message_str)
                event_type = server_event.get("type")
                
                logger.info(f"[Manager {client_sid[:6]}] Evento inicial: {event_type}")
                
                if event_type == "session.created":
                    session_id = server_event.get("session_id")
                    logger.info(f"[Manager {client_sid[:6]}] Sessão criada com ID: {session_id}")
                    session_ready = True
                    break
                    
                elif event_type == "error" or "error" in str(event_type).lower():
                    error_details = server_event.get("message", str(server_event))
                    logger.error(f"[Manager {client_sid[:6]}] Erro ao criar sessão: {error_details}")
                    socketio.emit(
                        'processing_error', 
                        {'error': f'Erro ao inicializar OpenAI: {error_details}'}, 
                        room=client_sid
                    )
                    return
        
        except asyncio.TimeoutError:
            logger.error(f"[Manager {client_sid[:6]}] Timeout ao aguardar criação da sessão")
            socketio.emit('processing_error', {'error': 'Timeout ao inicializar OpenAI'}, room=client_sid)
            return
            
        except websockets.exceptions.ConnectionClosed as e:
            logger.error(f"[Manager {client_sid[:6]}] Conexão fechada durante inicialização: {e}")
            socketio.emit(
                'processing_error', 
                {'error': 'Conexão perdida durante inicialização OpenAI'}, 
                room=client_sid
            )
            return
        
        # Verificar se a sessão foi criada com sucesso
        if not session_ready:
            raise Exception("Falha ao inicializar sessão OpenAI")
        
        # Se não tiver ID de sessão, gerar um
        if session_id is None:
            session_id = f"session_{client_sid}"
            logger.info(f"[Manager {client_sid[:6]}] Usando ID de sessão gerado: {session_id}")
        
        # Configurar formato de áudio para a sessão
        logger.info(f"[Manager {client_sid[:6]}] Configurando formato de áudio (PCM16 a {TARGET_INPUT_RATE}Hz)...")
        session_update_event = {
            "type": "session.update",
            "session_id": session_id,
            "session": {
                "input_audio_format": {
                    "encoding": "pcm16",
                    "sample_rate": TARGET_INPUT_RATE,
                    "channels": 1
                }
            }
        }
        
        await asyncio.wait_for(
            ws.send(json.dumps(session_update_event)), 
            timeout=5.0
        )
        
        # Iniciar tasks de sender e receiver
        logger.info(f"[Manager {client_sid[:6]}] Iniciando processamento de áudio...")
        sender_task = asyncio.create_task(
            openai_sender(client_sid, ws, audio_queue), 
            name=f"Sender_{client_sid[:6]}"
        )
        
        receiver_task = asyncio.create_task(
            openai_receiver(client_sid, ws), 
            name=f"Receiver_{client_sid[:6]}"
        )
        
        # Armazenar a tarefa principal
        client_tasks[client_sid] = asyncio.current_task()
        
        # Aguardar até que uma das tarefas termine
        done, pending = await asyncio.wait(
            [sender_task, receiver_task], 
            return_when=asyncio.FIRST_COMPLETED
        )
        
        # Cancelar a tarefa pendente
        for task in pending:
            logger.info(f"[Manager {client_sid[:6]}] Cancelando tarefa: {task.get_name()}")
            task.cancel()
            
            try:
                await task
            except asyncio.CancelledError:
                logger.info(f"[Manager {client_sid[:6]}] Tarefa {task.get_name()} cancelada")
            except Exception as e:
                logger.error(f"[Manager {client_sid[:6]}] Erro ao cancelar {task.get_name()}: {e}")
        
        # Verificar se houve erros nas tarefas concluídas
        for task in done:
            try:
                task.result()
            except Exception as e:
                logger.warning(f"[Manager {client_sid[:6]}] Tarefa {task.get_name()} concluída com erro")
    
    except Exception as e:
        logger.error(f"[Manager {client_sid[:6]}] Erro na sessão: {type(e).__name__}: {e}")
        logger.error(traceback.format_exc())
        socketio.emit('processing_error', {'error': f'Erro no processamento: {e}'}, room=client_sid)
    
    finally:
        # Limpeza de recursos
        logger.info(f"[Manager {client_sid[:6]}] Finalizando e liberando recursos...")
        
        # Cancelar tarefas
        if sender_task and not sender_task.done():
            sender_task.cancel()
        
        if receiver_task and not receiver_task.done():
            receiver_task.cancel()
        
        # Fechar WebSocket
        if ws and not ws.closed:
            logger.info(f"[Manager {client_sid[:6]}] Fechando conexão WebSocket...")
            try:
                await ws.close()
            except Exception as e:
                logger.warning(f"[Manager {client_sid[:6]}] Erro ao fechar WebSocket: {e}")
        
        # Remover das estruturas globais
        client_tasks.pop(client_sid, None)
        client_audio_queues.pop(client_sid, None)
        client_sample_rates.pop(client_sid, None)
        
        # Enviar sinal de fim ao cliente
        if client_sid in socketio.server.manager.rooms.get('/', {}).get(client_sid, set()):
            socketio.emit('audio_stream_end', {}, room=client_sid)
        
        logger.info(f"[Manager {client_sid[:6]}] Sessão finalizada")

# Socket.IO event handlers
@socketio.on('connect')
def handle_connect():
    """Gerencia conexão de novos clientes"""
    client_sid = request.sid
    logger.info(f"Cliente conectado: {client_sid[:6]}")
    
    # Certificar que sistema está inicializado
    if not initialization_done:
        initialize_env()
    
    if not openai_api_key:
        emit('processing_error', {'error': 'API OpenAI não configurada no servidor'})

@socketio.on('disconnect')
def handle_disconnect():
    """Gerencia desconexão de clientes"""
    client_sid = request.sid
    logger.info(f"Cliente desconectado: {client_sid[:6]}")
    
    # Enviar sinal de término para a fila
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            audio_queue.put_nowait(None)
            logger.info(f"Enviado sinal de término para {client_sid[:6]}")
        except Exception as e:
            logger.warning(f"Erro ao enviar sinal de término para {client_sid[:6]}: {e}")
    
    # Limpar dados do cliente
    client_sample_rates.pop(client_sid, None)

@socketio.on('start_recording')
def handle_start_recording(data):
    """Inicia o processo de gravação e processamento de áudio"""
    client_sid = request.sid
    client_sample_rate = data.get('sampleRate', 24000)
    
    logger.info(f"Iniciando gravação para {client_sid[:6]} (Taxa: {client_sample_rate}Hz)")
    
    # Armazenar taxa de amostragem do cliente
    client_sample_rates[client_sid] = client_sample_rate
    
    # Função para iniciar a tarefa de processamento em background
    def start_session_task():
        logger.info(f"Iniciando tarefa em background para {client_sid[:6]}")
        
        # Verificar se já existe uma tarefa ativa
        if client_sid in client_tasks:
            logger.warning(f"Já existe uma tarefa ativa para {client_sid[:6]}")
            return
        
        # Verificar configuração da API
        if not openai_api_key:
            logger.error(f"Chave API não configurada para {client_sid[:6]}")
            socketio.emit('processing_error', {'error': 'Chave API não configurada'}, room=client_sid)
            return
        
        # Criar fila para chunks de áudio
        audio_queue = asyncio.Queue()
        client_audio_queues[client_sid] = audio_queue
        
        # Função para executar a tarefa assíncrona principal
        async def run_main_task():
            task = asyncio.create_task(
                manage_openai_session(client_sid, audio_queue),
                name=f"Manager_{client_sid[:6]}"
            )
            
            client_tasks[client_sid] = task
            logger.info(f"Tarefa {task.get_name()} iniciada")
            
            try:
                await task
            except asyncio.CancelledError:
                logger.info(f"Tarefa {task.get_name()} cancelada externamente")
            finally:
                # Limpeza final
                client_tasks.pop(client_sid, None)
                client_audio_queues.pop(client_sid, None)
                client_sample_rates.pop(client_sid, None)
                logger.info(f"Tarefa {task.get_name()} finalizada")
        
        # Iniciar a tarefa
        try:
            asyncio.run(run_main_task())
            logger.info(f"Processamento para {client_sid[:6]} finalizado")
        except Exception as e:
            logger.error(f"Erro ao iniciar processamento para {client_sid[:6]}: {e}")
            client_audio_queues.pop(client_sid, None)
            client_tasks.pop(client_sid, None)
            client_sample_rates.pop(client_sid, None)
    
    # Iniciar a tarefa em background
    socketio.start_background_task(start_session_task)

@socketio.on('audio_input_chunk')
def handle_audio_input_chunk(data):
    """Processa chunks de áudio enviados pelo cliente"""
    client_sid = request.sid
    audio_chunk_base64 = data.get('audio')
    
    # Validar dados recebidos
    if not audio_chunk_base64:
        logger.warning(f"Chunk de áudio vazio de {client_sid[:6]}")
        return
    
    # Verificar se existe uma fila para este cliente
    audio_queue = client_audio_queues.get(client_sid)
    if not audio_queue:
        logger.warning(f"Fila de áudio não encontrada para {client_sid[:6]}")
        return
    
    # Obter taxa de amostragem do cliente
    original_sample_rate = client_sample_rates.get(client_sid, 24000)
    TARGET_SAMPLE_RATE = 16000  # Taxa requerida pela OpenAI
    
    try:
        # Decodificar o áudio de Base64
        audio_bytes = base64.b64decode(audio_chunk_base64)
        if not audio_bytes:
            logger.warning(f"Dados de áudio vazios de {client_sid[:6]}")
            return
        
        # Converter para AudioSegment
        try:
            audio_segment = AudioSegment(
                data=audio_bytes,
                sample_width=2,  # PCM16 = 2 bytes
                frame_rate=original_sample_rate,
                channels=1
            )
        except Exception as e:
            logger.error(f"Erro ao processar áudio de {client_sid[:6]}: {e}")
            return
        
        # Realizar resampling se necessário
        if audio_segment.frame_rate != TARGET_SAMPLE_RATE:
            audio_segment = audio_segment.set_frame_rate(TARGET_SAMPLE_RATE)
        
        # Garantir mono e PCM16
        audio_segment = audio_segment.set_channels(1)
        audio_segment = audio_segment.set_sample_width(2)
        
        # Obter dados raw PCM e converter para Base64
        pcm_data = audio_segment.raw_data
        resampled_audio_base64 = base64.b64encode(pcm_data).decode('utf-8')
        
        # Adicionar à fila para processamento
        try:
            audio_queue.put_nowait(resampled_audio_base64)
        except asyncio.QueueFull:
            logger.warning(f"Fila cheia para {client_sid[:6]}, chunk descartado")
        
    except Exception as e:
        logger.error(f"Erro ao processar chunk de {client_sid[:6]}: {e}")
        logger.error(traceback.format_exc())

@socketio.on('stop_recording')
def handle_stop_recording():
    """Para o processo de gravação"""
    client_sid = request.sid
    logger.info(f"Parando gravação para {client_sid[:6]}")
    
    # Enviar sinal para encerrar processamento
    audio_queue = client_audio_queues.get(client_sid)
    if audio_queue:
        try:
            audio_queue.put_nowait(None)
            logger.info(f"Enviado sinal de término para {client_sid[:6]}")
        except Exception as e:
            logger.error(f"Erro ao enviar sinal de término para {client_sid[:6]}: {e}")
    else:
        logger.warning(f"Fila não encontrada para {client_sid[:6]}")

# Inicialização da aplicação
if __name__ == "__main__":
    print("=== Assistente de Voz OpenAI Realtime ===")
    initialize_env()
    
    port = int(os.environ.get("PORT", 5000))
    host = os.environ.get("HOST", "0.0.0.0")
    
    print(f"Servidor pronto em http://{host}:{port}")
    
    socketio.run(
        app, 
        host=host, 
        port=port, 
        debug=True,
        use_reloader=False,
        allow_unsafe_werkzeug=True
    )