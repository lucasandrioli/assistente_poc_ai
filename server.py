# server.py (v22 - OpenAI S2S com Resample 24->16kHz no Backend - Syntax Fix Confirmed)

import os
import base64
import sys
import asyncio
import traceback
import json
from typing import Dict, Optional
import logging
import io # Necessário para pydub

import websockets # websockets==11.0.3

from flask import Flask, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

# --- REINTRODUZIDO: Importar pydub ---
try:
    from pydub import AudioSegment
    # Tentar forçar o uso do ffmpeg explicitamente se houver problemas
    # AudioSegment.converter = "/usr/bin/ffmpeg" # Ajuste o caminho se necessário
except ImportError:
    logging.error("*"*30); logging.error("ERRO FATAL: 'pydub' não encontrada. Verifique requirements.txt"); logging.error("*"*30); sys.exit(1)
except Exception as e_pydub_import:
     logging.error("*"*30); logging.error(f"ERRO FATAL: Problema ao inicializar pydub (ffmpeg instalado E no PATH?): {e_pydub_import}"); logging.error("*"*30); sys.exit(1)
# -------------------------------------

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', logger=True, engineio_logger=True)

# --- Variáveis Globais ---
openai_api_key = None
initialization_done = False
client_tasks: Dict[str, asyncio.Task] = {}
client_audio_queues: Dict[str, asyncio.Queue] = {}
client_sample_rates: Dict[str, int] = {}

# --- Inicialização ---
def initialize_env():
    global openai_api_key, initialization_done
    if initialization_done: return
    logging.info("--- Lendo Variáveis de Ambiente (OpenAI) ---")
    openai_api_key = os.getenv("OPENAI_API_KEY")
    if not openai_api_key: logging.error("*"*30); logging.error("ERRO FATAL: OPENAI_API_KEY não definida."); logging.error("*"*30); sys.exit(1)
    else: logging.info("Chave API OpenAI carregada do ambiente.")
    initialization_done = True
    logging.info("--- Fim da Leitura de Variáveis ---")

# --- Funções Assíncronas Auxiliares ---
async def openai_sender(client_sid: str, ws: websockets.WebSocketClientProtocol, audio_queue: asyncio.Queue):
    logging.info(f"[Sender {client_sid}] Iniciado. Aguardando chunks PCM 16kHz Base64...")
    while True:
        try:
            processed_audio_chunk_base64 = await asyncio.wait_for(audio_queue.get(), timeout=10.0)
            if processed_audio_chunk_base64 is None: logging.info(f"[Sender {client_sid}] Sinal de fim (None). Encerrando."); break
            audio_event = {"type": "input_audio_buffer.append", "audio": processed_audio_chunk_base64}
            # logging.info(f"[Sender {client_sid}] Enviando chunk Base64 (16kHz): {processed_audio_chunk_base64[:30]}...") # Debug
            await asyncio.wait_for(ws.send(json.dumps(audio_event)), timeout=5.0)
            audio_queue.task_done()
        except asyncio.TimeoutError:
            if ws.closed: logging.warning(f"[Sender {client_sid}] Timeout fila E conexão fechada."); break
            continue
        except websockets.exceptions.ConnectionClosed: logging.warning(f"[Sender {client_sid}] Conexão OpenAI fechada."); break
        except Exception as e_send: logging.error(f"[Sender {client_sid}] Erro ao enviar chunk: {e_send}"); break
    logging.info(f"[Sender {client_sid}] Finalizado.")

async def openai_receiver(client_sid: str, ws: websockets.WebSocketClientProtocol):
    logging.info(f"[Receiver {client_sid}] Iniciado. Aguardando eventos...")
    while True:
        try:
            message_str = await asyncio.wait_for(ws.recv(), timeout=60.0)
            server_event = json.loads(message_str); event_type = server_event.get("type")
            logging.info(f"[Receiver {client_sid}] Evento Recebido: {event_type}")
            if event_type == "response.audio.delta":
                audio_chunk_base64 = server_event.get("delta");
                if audio_chunk_base64: socketio.emit('audio_chunk', {'audio': audio_chunk_base64}, room=client_sid)
                else: logging.warning(f"[Receiver {client_sid}] audio.delta sem 'delta': {server_event}")
            elif event_type == "response.text.delta":
                text_chunk = server_event.get("delta")
                if text_chunk: socketio.emit('text_chunk', {'text': text_chunk}, room=client_sid)
            elif event_type == "response.done":
                logging.info(f"[Receiver {client_sid}] Evento 'response.done' recebido.")
                socketio.emit('audio_stream_end', {}, room=client_sid)
            elif event_type == "input_audio_buffer.speech_started": logging.info(f"[Receiver {client_sid}] OpenAI detectou início da fala.")
            elif event_type == "input_audio_buffer.speech_stopped": logging.info(f"[Receiver {client_sid}] OpenAI detectou fim da fala.")
            elif event_type == "error" or "error" in str(event_type).lower():
                error_details = server_event.get("message", str(server_event)); logging.error(f"[Receiver {client_sid}] ERRO API OpenAI: {error_details}")
                socketio.emit('processing_error', {'error': f'Erro API OpenAI: {error_details}'}, room=client_sid); break
        except asyncio.TimeoutError: logging.warning(f"[Receiver {client_sid}] Timeout OpenAI."); socketio.emit('processing_error', {'error': 'Timeout IA.'}, room=client_sid); break
        except websockets.exceptions.ConnectionClosedOK: logging.info(f"[Receiver {client_sid}] Conexão OpenAI fechada (OK)."); break
        except websockets.exceptions.ConnectionClosedError as e_closed_recv: logging.error(f"[Receiver {client_sid}] Conexão OpenAI fechada com ERRO: {e_closed_recv}"); socketio.emit('processing_error', {'error': 'Conexão perdida API OpenAI.'}, room=client_sid); break
        except Exception as e_recv: logging.error(f"[Receiver {client_sid}] Erro inesperado recv: {e_recv}"); logging.error(traceback.format_exc()); socketio.emit('processing_error', {'error': f'Erro comunicação: {e_recv}'}, room=client_sid); break
    logging.info(f"[Receiver {client_sid}] Finalizado.")
    # Garantir que o fim seja emitido mesmo se houver erro ou timeout
    if client_sid in socketio.server.manager.rooms['/'].get(client_sid, set()):
        socketio.emit('audio_stream_end', {}, room=client_sid)

async def manage_openai_session(client_sid: str, audio_queue: asyncio.Queue):
    """Task principal: Conecta, configura formato 16kHz, inicia sender/receiver."""
    global openai_api_key; logging.info(f"[Manager {client_sid}] Iniciando task principal...")
    if not openai_api_key: logging.error(f"[Manager {client_sid}] ERRO - API Key."); socketio.emit('processing_error', {'error': 'Erro interno (API Key).'}, room=client_sid); return
    TARGET_INPUT_RATE = 16000 # Target para OpenAI
    model_id = "gpt-4o-mini-realtime-preview"; OPENAI_WEBSOCKET_URI = f"wss://api.openai.com/v1/realtime?model={model_id}"; headers = { "Authorization": f"Bearer {openai_api_key}", "OpenAI-Beta": "realtime=v1" }
    ws: websockets.WebSocketClientProtocol|None = None; sender_task: asyncio.Task|None = None; receiver_task: asyncio.Task|None = None
    try:
        logging.info(f"[Manager {client_sid}] Conectando a {OPENAI_WEBSOCKET_URI}...")
        ws = await asyncio.wait_for(websockets.connect(OPENAI_WEBSOCKET_URI, extra_headers=headers), timeout=10.0)
        logging.info(f"[Manager {client_sid}] Conectado! Aguardando session.created...")
        session_ready = False; session_id = None
        try:
            while True:
                message_str = await asyncio.wait_for(ws.recv(), timeout=10.0)
                server_event = json.loads(message_str); event_type = server_event.get("type")
                logging.info(f"Evento Inicial Recebido (SID: {client_sid}): {event_type}")
                if event_type == "session.created": session_id = server_event.get("session_id"); logging.info(f"[Manager {client_sid}] Sessão OpenAI pronta (ID: {session_id})."); session_ready = True; break
                elif event_type == "error" or "error" in str(event_type).lower(): error_details = server_event.get("message", str(server_event)); logging.error(f"[Manager {client_sid}] ERRO init sessão: {error_details}"); socketio.emit('processing_error', {'error': f'Erro OpenAI init: {error_details}'}, room=client_sid); break
        except asyncio.TimeoutError: logging.error(f"[Manager {client_sid}] ERRO - Timeout session.created."); socketio.emit('processing_error', {'error': 'Timeout init OpenAI.'}, room=client_sid)
        except websockets.exceptions.ConnectionClosed as e_closed_init: logging.error(f"[Manager {client_sid}] ERRO - Conexão fechada init: {e_closed_init}"); socketio.emit('processing_error', {'error': 'Conexão perdida init OpenAI.'}, room=client_sid); session_ready = False
        if not session_ready or not session_id: raise Exception("Falha ao inicializar sessão OpenAI ou obter session_id.")

        logging.info(f"[Manager {client_sid}] Enviando configuração de áudio (PCM16 a {TARGET_INPUT_RATE}Hz)...")
        session_update_event = { "type": "session.update", "session_id": session_id, "session": { "input_audio_format": { "encoding": "pcm16", "sample_rate": TARGET_INPUT_RATE, "channels": 1 } } }
        await asyncio.wait_for(ws.send(json.dumps(session_update_event)), timeout=5.0)
        logging.info(f"[Manager {client_sid}] Configuração de áudio enviada. Iniciando tasks sender/receiver...")

        sender_task = asyncio.create_task(openai_sender(client_sid, ws, audio_queue), name=f"Sender_{client_sid}")
        receiver_task = asyncio.create_task(openai_receiver(client_sid, ws), name=f"Receiver_{client_sid}")
        client_tasks[client_sid] = asyncio.current_task()
        done, pending = await asyncio.wait([sender_task, receiver_task], return_when=asyncio.FIRST_COMPLETED)
        
        # Cancela a task pendente (CORRIGIDO)
        for task in pending:
            logging.info(f"[Manager {client_sid}] Cancelando task pendente: {task.get_name()}")
            task.cancel()
            try:
                await task 
            except asyncio.CancelledError:
                 logging.info(f"[Manager {client_sid}] Task {task.get_name()} cancelada com sucesso.")
            except Exception as e_cancel:
                 logging.error(f"[Manager {client_sid}] Erro ao esperar cancelamento da task {task.get_name()}: {e_cancel}")
                 
        # Verifica exceções nas tasks concluídas (CORRIGIDO)
        for task in done:
            try:
                task.result() 
            except Exception as e_done:
                 logging.warning(f"[Manager {client_sid}] Task {task.get_name()} concluída com exceção (já logada).")

    except Exception as e_main: 
        logging.error(f"[Manager {client_sid}] ERRO na task principal: {type(e_main).__name__}: {e_main}"); 
        logging.error(traceback.format_exc()); 
        socketio.emit('processing_error', {'error': f'Erro geral backend: {e_main}'}, room=client_sid)
    finally:
        logging.info(f"[Manager {client_sid}] Finally: Limpando recursos...")
        if sender_task and not sender_task.done(): sender_task.cancel()
        if receiver_task and not receiver_task.done(): receiver_task.cancel()
        if ws and not ws.closed: 
            logging.info(f"[Manager {client_sid}] Fechando WS OpenAI..."); 
            try: await ws.close()
            except Exception as e_close_ws: logging.warning(f"[Manager {client_sid}] Erro ao fechar WS OpenAI: {e_close_ws}")
            logging.info(f"[Manager {client_sid}] WS OpenAI fechado.")
        client_tasks.pop(client_sid, None); client_audio_queues.pop(client_sid, None); client_sample_rates.pop(client_sid, None); 
        logging.info(f"[Manager {client_sid}] Dicionários limpos.")
        if client_sid in socketio.server.manager.rooms['/'].get(client_sid, set()):
             socketio.emit('audio_stream_end', {}, room=client_sid)
        logging.info(f"[Manager {client_sid}] Task principal finalizada.")

# --- Eventos SocketIO ---
@socketio.on('connect')
def handle_connect():
    client_sid = request.sid
    logging.info(f"Cliente conectado: {client_sid}")
    if not initialization_done: initialize_env()
    if not openai_api_key: emit('processing_error', {'error': 'API Key não configurada.'})

@socketio.on('disconnect')
def handle_disconnect(): # SÍNCRONO
    client_sid = request.sid
    logging.info(f"Cliente desconectado do SocketIO: {client_sid}. Tentando sinalizar fila...")
    audio_queue = client_audio_queues.get(client_sid)
    # ***** Bloco try/except CORRETO *****
    if audio_queue: 
        try: 
            audio_queue.put_nowait(None)
            logging.info(f"Sinal None enviado para fila de {client_sid}.") 
        except Exception as e: 
            logging.warning(f"Erro put None {client_sid}: {e}")
    # ************************************
    client_sample_rates.pop(client_sid, None)

@socketio.on('start_recording')
def handle_start_recording(data): # SÍNCRONO
    client_sid = request.sid
    client_sample_rate = data.get('sampleRate') 
    logging.info(f"Evento 'start_recording' recebido de {client_sid}. Sample Rate: {client_sample_rate}")
    if client_sample_rate: client_sample_rates[client_sid] = client_sample_rate
    else: logging.warning(f"Sample rate não recebido do cliente {client_sid}, usando padrão 16000."); client_sample_rates[client_sid] = 16000 
    
    def starter(): 
        logging.info(f"Starter para {client_sid}: Verificando e iniciando task...")
        if client_sid in client_tasks: logging.warning(f"Task já existe para {client_sid}. Ignorando."); return
        if not openai_api_key: logging.error(f"API Key não configurada para {client_sid}."); socketio.emit('processing_error', {'error': 'API Key não configurada.'}, room=client_sid); return
        audio_queue = asyncio.Queue(); client_audio_queues[client_sid] = audio_queue
        
        async def run_main_task(): 
              task = asyncio.create_task(manage_openai_session(client_sid, audio_queue), name=f"Manager_{client_sid}")
              client_tasks[client_sid] = task; logging.info(f"Task {task.get_name()} armazenada.")
              try: await task
              except asyncio.CancelledError: logging.info(f"Task {task.get_name()} foi cancelada externamente.")
              finally: client_tasks.pop(client_sid, None); client_audio_queues.pop(client_sid, None); client_sample_rates.pop(client_sid, None); logging.info(f"Task {task.get_name()} removida (wrapper).")
                  
        logging.info(f"Starter para {client_sid}: Rodando run_main_task via asyncio.run...")
        try: asyncio.run(run_main_task()); logging.info(f"Starter para {client_sid}: asyncio.run finalizado.")
        except Exception as e_run_starter: 
            logging.error(f"Starter para {client_sid}: Erro: {e_run_starter}"); 
            client_audio_queues.pop(client_sid, None); 
            client_tasks.pop(client_sid, None); 
            client_sample_rates.pop(client_sid, None) 
            
    socketio.start_background_task(starter); logging.info(f"Background task starter para {client_sid} iniciada.")

# ***** REINTRODUZIDO: Conversão pydub para RESAMPLE *****
@socketio.on('audio_input_chunk')
def handle_audio_input_chunk(data): # Handler SÍNCRONO
    """Recebe chunk PCM (taxa do cliente), resample para 16kHz e coloca na fila."""
    client_sid = request.sid
    audio_chunk_base64 = data.get('audio') 
    if not audio_chunk_base64: logging.warning(f"AVISO (SID: {client_sid}): 'audio_input_chunk' sem dados."); return
    
    audio_queue = client_audio_queues.get(client_sid)
    if not audio_queue: logging.warning(f"AVISO (SID: {client_sid}): Chunk recebido, sem fila ativa."); return

    original_sample_rate = client_sample_rates.get(client_sid, 24000) # Padrão 24k se não foi enviado
    TARGET_SAMPLE_RATE = 16000 

    try:
        audio_bytes = base64.b64decode(audio_chunk_base64)
        if not audio_bytes: logging.warning(f"AVISO (SID: {client_sid}): Chunk Base64 vazio."); return

        try: 
            audio_segment = AudioSegment(
                data=audio_bytes,
                sample_width=2, # PCM16 = 2 bytes
                frame_rate=original_sample_rate,
                channels=1
            )
        except Exception as e_pydub_load: 
            logging.error(f"Erro Pydub load (PCM {original_sample_rate}Hz?) {client_sid}: {e_pydub_load}")
            logging.error(f"Bytes recebidos (início): {audio_bytes[:50]}") 
            return

        if audio_segment.frame_rate != TARGET_SAMPLE_RATE:
            # logging.info(f"Resampling de {audio_segment.frame_rate}Hz para {TARGET_SAMPLE_RATE}Hz...")
            audio_segment = audio_segment.set_frame_rate(TARGET_SAMPLE_RATE)
        
        audio_segment = audio_segment.set_channels(1)
        audio_segment = audio_segment.set_sample_width(2) 

        pcm_16k_bytes = audio_segment.raw_data
        resampled_audio_base64 = base64.b64encode(pcm_16k_bytes).decode('utf-8')

        try: 
            audio_queue.put_nowait(resampled_audio_base64)
        except asyncio.QueueFull: 
            logging.warning(f"Fila de áudio {client_sid} cheia! Chunk descartado.")
        
    except Exception as e_conv: 
         logging.error(f"Erro geral ao converter/enfileirar chunk para {client_sid}: {e_conv}")
         logging.error(traceback.format_exc())
# ********************************************************************

@socketio.on('stop_recording')
def handle_stop_recording(): # Handler SÍNCRONO
    client_sid = request.sid; logging.info(f"Evento 'stop_recording' recebido de {client_sid}.")
    audio_queue = client_audio_queues.get(client_sid)
    # ***** Bloco try/except CORRETO *****
    if audio_queue: 
        try: 
            audio_queue.put_nowait(None)
            logging.info(f"Sinal None para fila de {client_sid}.") 
        except Exception as e: 
            logging.error(f"Erro put None {client_sid}: {e}")
    else: 
        logging.warning(f"AVISO (SID: {client_sid}): stop_recording sem fila ativa.")
    # ************************************

# --- Ponto de Entrada Principal ---
if __name__ == "__main__":
    print("Iniciando servidor Flask-SocketIO (OpenAI Realtime S2S)..."); initialize_env(); port_to_use = 5000
    print(f"Servidor pronto. Escutando em http://0.0.0.0:{port_to_use} ..."); socketio.run(app, host="0.0.0.0", port=port_to_use, debug=True, use_reloader=False, allow_unsafe_werkzeug=True)