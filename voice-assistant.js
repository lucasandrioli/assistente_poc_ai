// voice-assistant.js - Cliente para Assistente de Voz OpenAI Realtime

// Elementos DOM
const recordButton = document.getElementById('record-button');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');

// Configurações
const SERVER_URL = window.location.origin; // URL do servidor (mesmo domínio)
const EXPECTED_SAMPLE_RATE = 24000; // Taxa de amostragem desejada para o AudioContext

// Estado da aplicação
let audioContext = null;
let socket = null;
let isRecording = false;
let localStream = null;
let sourceNode = null;
let processorNode = null;
let scriptProcessorNode = null;
let useWorklet = false;
let audioQueue = [];
let isPlayingQueue = false;
let audioPlayingSource = null;
let conversationHistory = "";
let lastUserQuery = "";
let canInterrupt = true; // Flag para controlar se o modelo pode ser interrompido

// Inicialização
async function initialize() {
    console.log("Inicializando assistente de voz...");
    setStatus('Carregando...', true);
    recordButton.disabled = true;
    
    try {
        // 1. Verificar suporte a APIs de áudio
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || 
            !window.AudioContext) {
            throw new Error("Seu navegador não suporta as APIs de áudio necessárias");
        }
        
        // 2. Criar contexto de áudio
        console.log("Criando AudioContext...");
        audioContext = new AudioContext({ sampleRate: EXPECTED_SAMPLE_RATE });
        console.log(`AudioContext criado. Taxa: ${audioContext.sampleRate}Hz (Esperado: ${EXPECTED_SAMPLE_RATE}Hz)`);
        
        if (audioContext.sampleRate !== EXPECTED_SAMPLE_RATE) {
            console.warn(`Atenção: O navegador usa ${audioContext.sampleRate}Hz ao invés de ${EXPECTED_SAMPLE_RATE}Hz`);
        }
        
        // AudioContext pode iniciar suspenso em alguns navegadores
        if (audioContext.state === 'suspended') {
            console.warn("AudioContext iniciou suspenso. Será retomado na interação do usuário.");
        }

        // 3. Conectar ao servidor via Socket.IO
        console.log("Conectando ao servidor:", SERVER_URL);
        connectWebSocket();
        
        // 4. Adicionar dica visual
        updateUIHint("Para começar, clique no botão do microfone e fale. Para interromper a IA enquanto ela responde, clique novamente no botão.");
        
    } catch (error) {
        console.error("Erro na inicialização:", error);
        setStatus(`Erro: ${error.message}`, false);
        showError(`Falha na inicialização: ${error.message}`);
    }
}

// Conexão WebSocket
function connectWebSocket() {
    if (socket) {
        console.log("Desconectando socket anterior...");
        socket.disconnect();
    }
    
    socket = io(SERVER_URL, { 
        transports: ['websocket'], 
        reconnectionAttempts: 5,
        timeout: 10000
    });
    
    // Eventos de conexão
    socket.on('connect', () => {
        console.log('Conexão estabelecida com o servidor:', socket.id);
        setStatus('Clique para falar', false);
        recordButton.disabled = false;
        recordButton.onclick = toggleRecording;
    });
    
    socket.on('disconnect', (reason) => {
        console.warn('Desconectado do servidor:', reason);
        setStatus('Desconectado', false);
        recordButton.disabled = true;
        recordButton.onclick = null;
        stopRecording();
    });
    
    socket.on('connect_error', (error) => {
        console.error('Erro de conexão:', error);
        setStatus('Erro de conexão', false);
        showError('Não foi possível conectar ao servidor. Verifique se o servidor está em execução.');
        recordButton.disabled = true;
    });
    
    // Eventos da aplicação
    socket.on('audio_chunk', handleAudioChunk);
    socket.on('audio_stream_end', handleAudioStreamEnd);
    socket.on('text_chunk', handleTextChunk);
    socket.on('processing_error', handleError);
    socket.on('speech_started', handleSpeechStarted);
    socket.on('speech_stopped', handleSpeechStopped);
}

// Evento quando o modelo detecta início de fala
function handleSpeechStarted() {
    console.log("Fala detectada pela API");
    // Atualizar interface para mostrar que está escutando
    setStatus('Ouvindo...', true);
    
    // Adicionar classe visual para indicar que está detectando fala
    transcriptDiv.classList.add('detecting-speech');
}

// Evento quando o modelo detecta fim de fala
function handleSpeechStopped() {
    console.log("Fim de fala detectado pela API");
    transcriptDiv.classList.remove('detecting-speech');
    setStatus('Processando...', true);
}

// Controle de gravação
async function toggleRecording() {
    console.log(`Alternando gravação. Estado atual: ${isRecording ? "gravando" : "parado"}`);
    
    if (isRecording) {
        if (isPlayingQueue) {
            // Se estiver reproduzindo áudio, interrompe o modelo
            interruptModel();
        } else {
            stopRecording();
        }
    } else {
        // Se o AudioContext estiver suspenso, é necessário retomar
        if (audioContext && audioContext.state === 'suspended') {
            try {
                console.log("Retomando AudioContext...");
                await audioContext.resume();
                console.log("AudioContext retomado com sucesso");
                startRecording();
            } catch (error) {
                console.error("Erro ao retomar AudioContext:", error);
                setStatus("Erro no sistema de áudio", false);
                showError("Não foi possível acessar o sistema de áudio");
            }
        } else {
            startRecording();
        }
    }
}

// Nova função para interromper o modelo
function interruptModel() {
    console.log("Tentando interromper o modelo...");
    if (!canInterrupt) {
        showMessage("Não é possível interromper neste momento");
        return;
    }
    
    // Parar reprodução atual
    stopAudioPlayback();
    
    // Limpar fila de áudio
    audioQueue = [];
    isPlayingQueue = false;
    
    // Mostrar visualmente que a IA foi interrompida
    showMessage("IA interrompida", "info");
    
    // Desabilitar temporariamente a interrupção para evitar spam
    canInterrupt = false;
    setTimeout(() => { canInterrupt = true; }, 2000);
    
    // Inicia nova gravação
    startRecording();
}

async function startRecording() {
    // Verificar conexão com o servidor
    if (!socket || !socket.connected) {
        setStatus("Sem conexão com o servidor", false);
        return;
    }
    
    // Evitar iniciar gravação duplicada
    if (isRecording) return;
    
    // Preparar ambiente
    lastUserQuery = ""; // Reset do estado da consulta
    setStatus('Ouvindo...', true);
    resetAudioPlayback();
    stopAudioPlayback();
    
    try {
        console.log("Solicitando permissão do microfone...");
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }, 
            video: false 
        });
        
        console.log("Permissão concedida. Configurando fluxo de áudio...");
        
        // Configurar nós de áudio usando ScriptProcessor (API mais compatível)
        sourceNode = audioContext.createMediaStreamSource(localStream);
        scriptProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
        
        scriptProcessorNode.onaudioprocess = function(audioProcessingEvent) {
            if (!isRecording) return;
            
            const inputBuffer = audioProcessingEvent.inputBuffer;
            const inputData = inputBuffer.getChannelData(0);
            
            // Converter Float32Array para Int16Array
            const pcmBuffer = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                // Converter de Float32 [-1,1] para Int16 [-32768,32767]
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // Converter para Base64 e enviar
            if (socket && socket.connected) {
                const base64Audio = arrayBufferToBase64Sync(pcmBuffer.buffer);
                socket.emit('audio_input_chunk', { audio: base64Audio });
            }
        };
        
        // Conectar nós
        sourceNode.connect(scriptProcessorNode);
        scriptProcessorNode.connect(audioContext.destination);
        
        // Atualizar estado
        isRecording = true;
        recordButton.classList.add('recording');
        recordButton.title = "Clique para parar";
        recordButton.innerHTML = '<i class="fas fa-stop"></i>';
        
        // Feedback visual de que está gravando
        transcriptDiv.classList.add('recording-active');
        
        // Notificar servidor sobre início da gravação
        socket.emit('start_recording', { sampleRate: audioContext.sampleRate });
        console.log("Gravação iniciada com sucesso");
        
    } catch (error) {
        console.error("Erro ao iniciar gravação:", error);
        
        if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
            setStatus("Permissão de microfone negada", false);
            showError("É necessário permitir o acesso ao microfone para usar o assistente de voz");
        } else {
            setStatus(`Erro: ${error.message}`, false);
            showError(`Falha ao acessar microfone: ${error.message}`);
        }
        
        stopRecording();
    }
}

function stopRecording() {
    console.log("Parando gravação...");
    
    // Remover classe visual
    transcriptDiv.classList.remove('recording-active');
    transcriptDiv.classList.remove('detecting-speech');
    
    // Desconectar nós de áudio
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch(e) {}
        sourceNode = null;
    }
    
    if (scriptProcessorNode) {
        try { scriptProcessorNode.disconnect(); } catch(e) {}
        scriptProcessorNode = null;
    }
    
    // Parar streams do microfone
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Notificar servidor
    if (socket && socket.connected && isRecording) {
        socket.emit('stop_recording');
    }
    
    // Atualizar estado
    isRecording = false;
    recordButton.classList.remove('recording');
    recordButton.title = "Clique para falar";
    recordButton.innerHTML = '<i class="fas fa-microphone"></i>';
    
    if (lastUserQuery.trim()) {
        setStatus('Processando...', true);
    } else {
        setStatus('Clique para falar', false);
    }
    
    console.log("Gravação parada com sucesso");
}

// Manipuladores de eventos de resposta
function handleAudioChunk(data) {
    if (!data || !data.audio) return;
    
    try {
        // Decodificar Base64 para ArrayBuffer
        const binaryString = atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Adicionar à fila de reprodução
        audioQueue.push(bytes.buffer);
    } catch (error) {
        console.error("Erro ao processar chunk de áudio:", error);
    }
}

function handleAudioStreamEnd() {
    console.log("Fim do stream de áudio recebido");
    playConcatenatedAudio();
}

function handleTextChunk(data) {
    if (!data || !data.text) return;
    
    // Se este é o primeiro chunk, é resposta a uma nova consulta
    if (!conversationHistory.includes("IA:")) {
        // Adicionar a pergunta do usuário ao histórico
        if (lastUserQuery) {
            conversationHistory += `Você: ${lastUserQuery}\n\n`;
        }
        conversationHistory += "IA: ";
        
        // Atualizar interface para mostrar que a IA está respondendo
        transcriptDiv.classList.add('ai-responding');
    }
    
    // Adicionar texto ao histórico
    conversationHistory += data.text;
    
    // Atualizar exibição
    transcriptDiv.textContent = conversationHistory;
    
    // Rolagem automática
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function handleError(data) {
    const errorMessage = data && data.error ? data.error : "Erro desconhecido";
    console.error("Erro recebido do servidor:", errorMessage);
    
    setStatus("Erro", false);
    showError(errorMessage);
    
    // Limpar classes visuais
    transcriptDiv.classList.remove('recording-active');
    transcriptDiv.classList.remove('detecting-speech');
    transcriptDiv.classList.remove('ai-responding');
    
    resetAudioPlayback();
    stopRecording();
    
    // Habilitar botão apenas se estiver conectado
    recordButton.disabled = !(socket && socket.connected);
}

// Utilidades de áudio
function resetAudioPlayback() {
    console.log("Resetando sistema de reprodução");
    audioQueue = [];
    isPlayingQueue = false;
    stopAudioPlayback();
}

function stopAudioPlayback() {
    if (audioPlayingSource) {
        try {
            audioPlayingSource.onended = null;
            audioPlayingSource.stop();
        } catch(e) {}
        audioPlayingSource = null;
    }
    isPlayingQueue = false;
    
    // Remover classe visual quando parar de reproduzir
    transcriptDiv.classList.remove('ai-responding');
}

async function playConcatenatedAudio() {
    // Verificar se há áudio para reproduzir e se não está reproduzindo
    if (audioQueue.length === 0 || isPlayingQueue) {
        if (audioQueue.length === 0 && !isRecording) {
            setStatus('Clique para falar', false);
            recordButton.disabled = !(socket && socket.connected);
        }
        return;
    }
    
    isPlayingQueue = true;
    setStatus('Reproduzindo resposta...', true);
    
    try {
        // Aguardar um momento para garantir que todos os chunks cheguem
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Juntar todos os chunks em um único buffer
        let totalLength = 0;
        audioQueue.forEach(buffer => totalLength += buffer.byteLength);
        
        if (totalLength === 0) {
            console.warn("Nenhum áudio recebido para reprodução");
            resetAudioPlayback();
            setStatus('Nenhum áudio recebido', false);
            return;
        }
        
        // Criar buffer contíguo
        const audioData = new Uint8Array(totalLength);
        let offset = 0;
        audioQueue.forEach(buffer => {
            audioData.set(new Uint8Array(buffer), offset);
            offset += buffer.byteLength;
        });
        
        // Limpar fila após consolidação
        audioQueue = [];
        
        // Criar cabeçalho WAV (PCM 16-bit, 24kHz, mono)
        const wavHeader = createWavHeader(audioData.byteLength, 24000);
        const wavBuffer = new Uint8Array(wavHeader.byteLength + audioData.byteLength);
        wavBuffer.set(new Uint8Array(wavHeader), 0);
        wavBuffer.set(audioData, wavHeader.byteLength);
        
        // Verificar estado do AudioContext
        if (!audioContext || audioContext.state !== 'running') {
            console.warn("AudioContext não está pronto para reprodução");
            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            await audioContext.resume();
        }
        
        // Decodificar WAV para AudioBuffer
        const audioBuffer = await audioContext.decodeAudioData(wavBuffer.buffer);
        
        // Reproduzir áudio
        stopAudioPlayback(); // Parar qualquer reprodução anterior
        audioPlayingSource = audioContext.createBufferSource();
        audioPlayingSource.buffer = audioBuffer;
        audioPlayingSource.connect(audioContext.destination);
        
        // Mostrar que a IA está falando
        transcriptDiv.classList.add('ai-responding');
        
        // Configurar evento de finalização
        audioPlayingSource.onended = () => {
            console.log("Reprodução finalizada");
            audioPlayingSource = null;
            isPlayingQueue = false;
            setStatus('Clique para falar', false);
            recordButton.disabled = !(socket && socket.connected);
            
            // Remover classe visual quando parar de falar
            transcriptDiv.classList.remove('ai-responding');
        };
        
        // Permitir interrupção durante reprodução
        canInterrupt = true;
        
        // Iniciar reprodução
        audioPlayingSource.start(0);
        console.log("Reprodução iniciada");
        
    } catch (error) {
        console.error("Erro na reprodução de áudio:", error);
        setStatus('Erro na reprodução', false);
        showError("Não foi possível reproduzir a resposta em áudio");
        resetAudioPlayback();
    }
}

// Utilidades de interface
function setStatus(message, showLoading = false) {
    statusDiv.innerHTML = message;
    
    if (showLoading) {
        const loadingDots = document.createElement('div');
        loadingDots.className = 'loading-dots';
        
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'dot';
            loadingDots.appendChild(dot);
        }
        
        statusDiv.appendChild(loadingDots);
    }
    
    // Gerenciamento de estados do botão
    const isBusy = isPlayingQueue || 
                  message.includes('Processando') || 
                  message.includes('Reproduzindo') || 
                  message.includes('Ouvindo') || 
                  showLoading;
    
    // Sempre permitir interação se estiver reproduzindo áudio (para interromper)
    const canInteract = socket && socket.connected && (isRecording || !isBusy || isPlayingQueue);
    recordButton.disabled = !canInteract;
    
    if (isRecording) {
        recordButton.classList.add('recording');
        recordButton.title = "Clique para parar";
        recordButton.innerHTML = '<i class="fas fa-stop"></i>';
    } else if (isPlayingQueue) {
        // Visual especial para quando está reproduzindo e pode ser interrompido
        recordButton.classList.remove('recording');
        recordButton.classList.add('can-interrupt');
        recordButton.title = "Clique para interromper a IA";
        recordButton.innerHTML = '<i class="fas fa-hand"></i>';
    } else {
        recordButton.classList.remove('recording');
        recordButton.classList.remove('can-interrupt');
        recordButton.title = canInteract ? "Clique para falar" : "Indisponível";
        recordButton.innerHTML = '<i class="fas fa-microphone"></i>';
    }
}

function showError(message) {
    // Verificar se já existe uma mensagem de erro
    let errorElement = document.querySelector('.error');
    
    if (!errorElement) {
        // Criar novo elemento de erro
        errorElement = document.createElement('div');
        errorElement.className = 'error';
        document.querySelector('.status-container').appendChild(errorElement);
    }
    
    // Definir mensagem
    errorElement.textContent = message;
    
    // Remover após 5 segundos
    setTimeout(() => {
        if (errorElement && errorElement.parentNode) {
            errorElement.parentNode.removeChild(errorElement);
        }
    }, 5000);
}

// Nova função para exibir mensagens de sistema
function showMessage(message, type = "info") {
    let messageElement = document.querySelector('.system-message');
    
    if (!messageElement) {
        messageElement = document.createElement('div');
        messageElement.className = 'system-message';
        document.querySelector('.status-container').appendChild(messageElement);
    }
    
    messageElement.className = `system-message ${type}`;
    messageElement.textContent = message;
    
    // Remover após 3 segundos
    setTimeout(() => {
        if (messageElement && messageElement.parentNode) {
            messageElement.parentNode.removeChild(messageElement);
        }
    }, 3000);
}

// Nova função para mostrar dicas de uso
function updateUIHint(message) {
    let hintElement = document.querySelector('.ui-hint');
    
    if (!hintElement) {
        hintElement = document.createElement('div');
        hintElement.className = 'ui-hint';
        document.querySelector('.assistant-container').appendChild(hintElement);
    }
    
    hintElement.textContent = message;
}

// Utilidades de processamento de áudio
function arrayBufferToBase64Sync(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function createWavHeader(dataLength, sampleRate, numChannels = 1, bitsPerSample = 16) {
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    
    // "RIFF" chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, 'WAVE');
    
    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    
    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);
    
    return buffer;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Manipulação de eventos de transcrição
document.addEventListener('keydown', function(event) {
    // Verificar se está gravando e pressionou Espaço
    if (event.code === 'Space' && !event.repeat) {
        if (!recordButton.disabled) {
            event.preventDefault();
            toggleRecording();
        }
    }
    
    // Salvar fala atual como última consulta quando parar a gravação
    if (isRecording && event.code === 'Escape') {
        const transcript = transcriptDiv.textContent;
        const userPart = transcript.split('Você:').pop().split('IA:')[0];
        if (userPart && userPart.trim()) {
            lastUserQuery = userPart.trim();
        }
    }
});

// Evento de conclusão da carga da página
window.addEventListener('load', initialize);

// Evento para reiniciar conexão após perda
window.addEventListener('online', function() {
    console.log("Conexão à rede detectada. Tentando reconectar...");
    if (socket && !socket.connected) {
        connectWebSocket();
    }
});

// Anexar ao objeto Window para depuração
window.voiceAssistant = {
    resetConversation: function() {
        conversationHistory = "";
        lastUserQuery = "";
        transcriptDiv.textContent = "(Aguardando sua pergunta...)";
        transcriptDiv.classList.remove('recording-active');
        transcriptDiv.classList.remove('detecting-speech');
        transcriptDiv.classList.remove('ai-responding');
        setStatus('Clique para falar', false);
        console.log("Conversação resetada");
    }
}