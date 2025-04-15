// simple-voice.js - Cliente simplificado para o Assistente de Voz

// Elementos DOM
const recordButton = document.getElementById('record-button');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript');

// Configurações
const SERVER_URL = window.location.origin;
const EXPECTED_SAMPLE_RATE = 24000;

// Estado da aplicação
let audioContext = null;
let socket = null;
let isRecording = false;
let localStream = null;
let sourceNode = null;
let scriptProcessorNode = null;
let audioQueue = [];
let isPlayingQueue = false;
let audioPlayingSource = null;
let conversationHistory = "";
let lastUserQuery = "";

// Inicialização
async function initialize() {
    console.log("Inicializando assistente de voz...");
    setStatus('Carregando...', true);
    recordButton.disabled = true;
    
    try {
        // Verificar suporte a APIs de áudio
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || 
            !window.AudioContext) {
            throw new Error("Seu navegador não suporta as APIs de áudio necessárias");
        }
        
        // Criar contexto de áudio
        console.log("Criando AudioContext...");
        audioContext = new AudioContext({ sampleRate: EXPECTED_SAMPLE_RATE });
        console.log(`AudioContext criado. Taxa: ${audioContext.sampleRate}Hz`);
        
        // Conectar ao servidor
        console.log("Conectando ao servidor:", SERVER_URL);
        connectWebSocket();
        
    } catch (error) {
        console.error("Erro na inicialização:", error);
        setStatus(`Erro: ${error.message}`, false);
        showError(`Falha na inicialização: ${error.message}`);
    }
}

// Conexão WebSocket
function connectWebSocket() {
    if (socket) {
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
    
    // Eventos da aplicação
    socket.on('audio_chunk', handleAudioChunk);
    socket.on('audio_stream_end', handleAudioStreamEnd);
    socket.on('text_chunk', handleTextChunk);
    socket.on('processing_error', handleError);
}

// Controle de gravação
async function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        // Retomar AudioContext se necessário
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        startRecording();
    }
}

async function startRecording() {
    // Verificar conexão
    if (!socket || !socket.connected) {
        setStatus("Sem conexão com o servidor", false);
        return;
    }
    
    if (isRecording) return;
    
    // Preparar ambiente
    setStatus('Ouvindo...', true);
    resetAudioPlayback();
    
    try {
        // Acessar microfone
        localStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true
            }
        });
        
        // Configurar processamento de áudio com ScriptProcessor
        sourceNode = audioContext.createMediaStreamSource(localStream);
        scriptProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
        
        // Processar áudio
        scriptProcessorNode.onaudioprocess = function(event) {
            if (!isRecording) return;
            
            const inputData = event.inputBuffer.getChannelData(0);
            
            // Converter Float32 para Int16
            const pcmBuffer = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            
            // Converter para Base64 e enviar
            if (socket && socket.connected) {
                const base64Audio = arrayBufferToBase64(pcmBuffer.buffer);
                socket.emit('audio_input_chunk', { audio: base64Audio });
            }
        };
        
        // Conectar nós
        sourceNode.connect(scriptProcessorNode);
        scriptProcessorNode.connect(audioContext.destination);
        
        // Atualizar estado
        isRecording = true;
        recordButton.classList.add('recording');
        recordButton.innerHTML = '<i class="fas fa-stop"></i>';
        
        // Notificar servidor
        socket.emit('start_recording', { sampleRate: audioContext.sampleRate });
        
    } catch (error) {
        console.error("Erro ao iniciar gravação:", error);
        setStatus(`Erro: ${error.message}`, false);
        stopRecording();
    }
}

function stopRecording() {
    // Desconectar áudio
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch(e) {}
        sourceNode = null;
    }
    
    if (scriptProcessorNode) {
        try { scriptProcessorNode.disconnect(); } catch(e) {}
        scriptProcessorNode = null;
    }
    
    // Parar streams
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
    recordButton.innerHTML = '<i class="fas fa-microphone"></i>';
    setStatus('Processando...', true);
}

// Manipuladores de eventos
function handleAudioChunk(data) {
    if (!data || !data.audio) return;
    
    try {
        // Decodificar Base64
        const binaryString = atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Adicionar à fila
        audioQueue.push(bytes.buffer);
    } catch (error) {
        console.error("Erro ao processar áudio:", error);
    }
}

function handleAudioStreamEnd() {
    console.log("Fim do stream de áudio");
    playConcatenatedAudio();
}

function handleTextChunk(data) {
    if (!data || !data.text) return;
    
    // Atualizar transcrição
    if (!conversationHistory.includes("IA:")) {
        conversationHistory += `Você: ${lastUserQuery || "(áudio)"}\n\nIA: `;
    }
    
    conversationHistory += data.text;
    transcriptDiv.textContent = conversationHistory;
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function handleError(data) {
    const errorMessage = data && data.error ? data.error : "Erro desconhecido";
    console.error("Erro:", errorMessage);
    
    setStatus("Erro", false);
    showError(errorMessage);
    
    resetAudioPlayback();
    stopRecording();
}

// Utilitários
function resetAudioPlayback() {
    audioQueue = [];
    isPlayingQueue = false;
    if (audioPlayingSource) {
        try { audioPlayingSource.stop(); } catch(e) {}
        audioPlayingSource = null;
    }
}

async function playConcatenatedAudio() {
    if (audioQueue.length === 0 || isPlayingQueue) return;
    
    isPlayingQueue = true;
    setStatus('Reproduzindo resposta...', true);
    
    try {
        // Juntar chunks
        let totalLength = 0;
        audioQueue.forEach(b => totalLength += b.byteLength);
        
        const audioData = new Uint8Array(totalLength);
        let offset = 0;
        audioQueue.forEach(b => {
            audioData.set(new Uint8Array(b), offset);
            offset += b.byteLength;
        });
        
        // Criar WAV
        const wavHeader = createWavHeader(audioData.byteLength, 24000);
        const wavBuffer = new Uint8Array(wavHeader.byteLength + audioData.byteLength);
        wavBuffer.set(new Uint8Array(wavHeader), 0);
        wavBuffer.set(audioData, wavHeader.byteLength);
        
        // Reproduzir
        const audioBuffer = await audioContext.decodeAudioData(wavBuffer.buffer);
        audioPlayingSource = audioContext.createBufferSource();
        audioPlayingSource.buffer = audioBuffer;
        audioPlayingSource.connect(audioContext.destination);
        
        audioPlayingSource.onended = () => {
            audioPlayingSource = null;
            isPlayingQueue = false;
            setStatus('Clique para falar', false);
        };
        
        audioPlayingSource.start(0);
        
    } catch (error) {
        console.error("Erro na reprodução:", error);
        resetAudioPlayback();
        setStatus('Clique para falar', false);
    }
}

// Funções auxiliares
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function createWavHeader(dataLength, sampleRate) {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    
    // RIFF
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, 'WAVE');
    
    // fmt
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    
    // data
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);
    
    return buffer;
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

function setStatus(message, showLoading = false) {
    statusDiv.innerHTML = message;
    
    if (showLoading) {
        const dots = document.createElement('div');
        dots.className = 'loading-dots';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('div');
            dot.className = 'dot';
            dots.appendChild(dot);
        }
        statusDiv.appendChild(dots);
    }
    
    recordButton.disabled = !(socket && socket.connected) || (isPlayingQueue && !isRecording);
}

function showError(message) {
    let errorElement = document.querySelector('.error');
    
    if (!errorElement) {
        errorElement = document.createElement('div');
        errorElement.className = 'error';
        document.querySelector('.status-container').appendChild(errorElement);
    }
    
    errorElement.textContent = message;
    
    setTimeout(() => {
        if (errorElement && errorElement.parentNode) {
            errorElement.parentNode.removeChild(errorElement);
        }
    }, 5000);
}

// Inicialização
window.addEventListener('load', initialize);