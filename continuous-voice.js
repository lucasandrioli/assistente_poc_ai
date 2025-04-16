// continuous-voice.js - Implementação de chamada de voz contínua com IA

// Elementos da interface
const callStatusElement = document.querySelector('.call-status');
const userIndicator = document.querySelector('.user-indicator');
const aiIndicator = document.querySelector('.ai-indicator');
const userVisualizer = document.querySelector('.user-visualizer');
const aiVisualizer = document.querySelector('.ai-visualizer');
const transcriptElement = document.getElementById('transcript');
const toggleCallButton = document.getElementById('toggle-call');
const toggleMuteButton = document.getElementById('toggle-mute');
const endCallButton = document.getElementById('end-call');

// Configurações
const SERVER_URL = window.location.origin;
const EXPECTED_SAMPLE_RATE = 24000;
const BARS_COUNT = 30; // Número de barras no visualizador
const MIN_BAR_HEIGHT = 5; // Altura mínima das barras (px)
const MAX_BAR_HEIGHT = 50; // Altura máxima das barras (px)

// Estado da aplicação
let audioContext = null;
let analyserNode = null;
let socket = null;
let localStream = null;
let sourceNode = null;
let scriptProcessorNode = null;
let isCallActive = false;
let isMuted = false;
let isAISpeaking = false;
let isUserSpeaking = false;
let audioQueue = [];
let audioBufferQueue = [];
let isPlayingQueue = false;
let nextPlayTime = 0;
let audioStreamEnded = false;
let conversationHistory = "";

// Criar visualizadores de voz
function setupVisualizers() {
    // Criar barras para visualizador do usuário
    for (let i = 0; i < BARS_COUNT; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
        userVisualizer.appendChild(bar);
    }

    // Criar barras para visualizador da IA
    for (let i = 0; i < BARS_COUNT; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
        aiVisualizer.appendChild(bar);
    }
}

// Atualizar status da chamada
function updateCallStatus(status, message) {
    callStatusElement.className = `call-status ${status}`;
    callStatusElement.innerHTML = `<div class="pulse-dot"></div><span>${message}</span>`;
}

// Mostrar mensagem do sistema
function showSystemMessage(message, type = 'info') {
    let messageElement = document.querySelector('.system-message');
    
    if (!messageElement) {
        messageElement = document.createElement('div');
        messageElement.className = `system-message ${type}`;
        document.querySelector('.transcript-container').appendChild(messageElement);
    } else {
        messageElement.className = `system-message ${type}`;
    }
    
    messageElement.textContent = message;
    
    // Remover após 3 segundos
    setTimeout(() => {
        if (messageElement && messageElement.parentNode) {
            messageElement.parentNode.removeChild(messageElement);
        }
    }, 3000);
}

// Atualizar visuais de quem está falando
function updateSpeakingIndicators() {
    userIndicator.classList.toggle('active', isUserSpeaking);
    aiIndicator.classList.toggle('active', isAISpeaking);
}

// Animação de barras para o visualizador do usuário
function animateUserVisualizer(audioData) {
    const bars = userVisualizer.querySelectorAll('.bar');
    const barCount = bars.length;
    
    for (let i = 0; i < barCount; i++) {
        // Usar dados de frequência para determinar altura das barras
        const index = Math.floor(i * audioData.length / barCount);
        const value = audioData[index] / 255.0;
        
        const height = MIN_BAR_HEIGHT + value * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
        bars[i].style.height = `${height}px`;
    }
}

// Animação de barras para o visualizador da IA
function animateAIVisualizer() {
    if (!isAISpeaking) return;
    
    const bars = aiVisualizer.querySelectorAll('.bar');
    
    // Animação aleatória simulando voz da IA
    for (let i = 0; i < bars.length; i++) {
        const randomValue = Math.random();
        const height = MIN_BAR_HEIGHT + randomValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
        bars[i].style.height = `${height}px`;
    }
}

// Inicializar a aplicação
async function initialize() {
    console.log("Inicializando assistente de voz contínuo...");
    setupVisualizers();
    
    try {
        // Verificar suporte a APIs necessárias
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioContext) {
            throw new Error("Seu navegador não suporta as APIs de áudio necessárias");
        }
        
        // Criar contexto de áudio (suspenso inicialmente)
        audioContext = new AudioContext({ sampleRate: EXPECTED_SAMPLE_RATE });
        console.log(`AudioContext criado. Taxa: ${audioContext.sampleRate}Hz`);
        
        // Configurar handlers de eventos para os botões
        toggleCallButton.addEventListener('click', toggleCall);
        toggleMuteButton.addEventListener('click', toggleMute);
        endCallButton.addEventListener('click', endCall);
        
        // Iniciar com status de desconectado
        updateCallStatus('disconnected', 'Desconectado');
        
        // Configurar animação contínua para visualizador da IA
        setInterval(() => {
            animateAIVisualizer();
        }, 100);
        
    } catch (error) {
        console.error("Erro na inicialização:", error);
        showSystemMessage(`Erro: ${error.message}`, 'error');
    }
}

// Conectar ao servidor via WebSocket
function connectToServer() {
    if (socket) {
        socket.disconnect();
    }
    
    updateCallStatus('connecting', 'Conectando...');
    
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        timeout: 10000
    });
    
    // Eventos de conexão
    socket.on('connect', () => {
        console.log('Conexão estabelecida com o servidor:', socket.id);
        updateCallStatus('active', 'Chamada ativa');
        showSystemMessage('Conexão estabelecida', 'success');
    });
    
    socket.on('disconnect', (reason) => {
        console.warn('Desconectado do servidor:', reason);
        updateCallStatus('disconnected', 'Desconectado');
        stopAudioProcessing();
        resetAudioPlayback();
        isCallActive = false;
        updateButtonStates();
    });
    
    socket.on('connect_error', (error) => {
        console.error('Erro de conexão:', error);
        updateCallStatus('disconnected', 'Erro de conexão');
        showSystemMessage('Falha na conexão com o servidor', 'error');
    });
    
    // Eventos de aplicação
    socket.on('audio_chunk', handleAudioChunk);
    socket.on('audio_stream_end', handleAudioStreamEnd);
    socket.on('text_chunk', handleTextChunk);
    socket.on('speech_started', handleSpeechStarted);
    socket.on('speech_stopped', handleSpeechStopped);
    socket.on('processing_started', handleProcessingStarted);
    socket.on('response_starting', handleResponseStarting);
    socket.on('processing_error', handleError);
}

// Iniciar e parar a chamada
async function toggleCall() {
    if (isCallActive) {
        pauseCall();
    } else {
        await startCall();
    }
}

// Iniciar chamada
async function startCall() {
    try {
        // Atualizar estado
        updateCallStatus('connecting', 'Iniciando chamada...');
        
        // Ativar AudioContext se estiver suspenso
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        // Conectar ao servidor
        connectToServer();
        
        // Solicitar acesso ao microfone
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // Configurar processamento de áudio
        setupAudioProcessing();
        
        // Iniciar captura contínua
        startContinuousCapture();
        
        // Atualizar estado
        isCallActive = true;
        updateButtonStates();
        showSystemMessage('Chamada iniciada', 'success');
        
    } catch (error) {
        console.error("Erro ao iniciar chamada:", error);
        
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            showSystemMessage('Permissão de microfone negada', 'error');
        } else {
            showSystemMessage(`Erro: ${error.message}`, 'error');
        }
        
        updateCallStatus('disconnected', 'Erro');
    }
}

// Pausar chamada
function pauseCall() {
    // Implementação para pausar temporariamente
    if (isCallActive) {
        if (isMuted) {
            // Se já estiver mudo, volta ao normal
            toggleMute();
        } else {
            // Se não estiver mudo, pausa a chamada
            isMuted = true;
            updateButtonStates();
            showSystemMessage('Chamada pausada', 'info');
        }
    }
}

// Encerrar chamada
function endCall() {
    if (!isCallActive) return;
    
    // Parar todos os processos
    stopAudioProcessing();
    resetAudioPlayback();
    
    // Desconectar socket
    if (socket && socket.connected) {
        socket.disconnect();
    }
    
    // Atualizar estado
    isCallActive = false;
    isUserSpeaking = false;
    isAISpeaking = false;
    updateSpeakingIndicators();
    updateButtonStates();
    updateCallStatus('disconnected', 'Chamada encerrada');
    showSystemMessage('Chamada encerrada', 'info');
}

// Silenciar/reativar microfone
function toggleMute() {
    if (!isCallActive) return;
    
    isMuted = !isMuted;
    
    // Atualizar visual do botão
    toggleMuteButton.innerHTML = isMuted
        ? '<i class="fas fa-microphone-slash"></i>'
        : '<i class="fas fa-microphone"></i>';
    
    // Silenciar/reativar tracks de áudio
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
    }
    
    // Mostrar mensagem
    showSystemMessage(isMuted ? 'Microfone silenciado' : 'Microfone ativado', 'info');
}

// Atualizar estado dos botões
function updateButtonStates() {
    // Botão de chamada
    toggleCallButton.className = isCallActive
        ? 'control-button secondary'
        : 'control-button primary';
    
    toggleCallButton.innerHTML = isCallActive
        ? '<i class="fas fa-pause"></i>'
        : '<i class="fas fa-phone"></i>';
    
    toggleCallButton.title = isCallActive ? 'Pausar chamada' : 'Iniciar chamada';
    
    // Botão de mudo
    toggleMuteButton.disabled = !isCallActive;
    toggleMuteButton.innerHTML = isMuted
        ? '<i class="fas fa-microphone-slash"></i>'
        : '<i class="fas fa-microphone"></i>';
    
    // Botão de encerrar
    endCallButton.disabled = !isCallActive;
}

// Configurar processamento de áudio
function setupAudioProcessing() {
    // Criar nó fonte a partir do microfone
    sourceNode = audioContext.createMediaStreamSource(localStream);
    
    // Criar analisador para visualização
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.5;
    
    // Conectar fonte ao analisador
    sourceNode.connect(analyserNode);
    
    // Criar processador de script para captura de áudio
    scriptProcessorNode = audioContext.createScriptProcessor(4096, 1, 1);
    
    // Processar áudio capturado
    scriptProcessorNode.onaudioprocess = function(audioProcessingEvent) {
        if (!isCallActive || isMuted) return;
        
        // Processar dados para visualização
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        analyserNode.getByteFrequencyData(dataArray);
        
        // Detectar se o usuário está falando (nível de energia)
        const sum = dataArray.reduce((acc, val) => acc + val, 0);
        const average = sum / dataArray.length;
        
        // Atualizar estado de fala do usuário
        const threshold = 25; // Ajustar baseado em testes
        const newIsUserSpeaking = average > threshold;
        
        if (newIsUserSpeaking !== isUserSpeaking) {
            isUserSpeaking = newIsUserSpeaking;
            updateSpeakingIndicators();
        }
        
        // Animar visualizador apenas se o usuário estiver falando
        if (isUserSpeaking) {
            animateUserVisualizer(dataArray);
        }
        
        // Capturar dados de áudio e enviar para o servidor
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
        
        // Converter Float32 para Int16
        const pcmBuffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Converter para Base64 e enviar
        if (socket && socket.connected && isUserSpeaking) {
            const base64Audio = arrayBufferToBase64(pcmBuffer.buffer);
            socket.emit('audio_input_chunk', { audio: base64Audio });
        }
    };
    
    // Conectar nós
    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(audioContext.destination);
}

// Iniciar captura contínua de áudio
function startContinuousCapture() {
    // Notificar servidor que estamos começando
    if (socket && socket.connected) {
        socket.emit('start_recording', { sampleRate: audioContext.sampleRate });
    }
    
    // Limpar histórico de conversa anterior?
    // conversationHistory = "";
    // transcriptElement.textContent = "(Aguardando sua pergunta...)";
}

// Parar processamento de áudio
function stopAudioProcessing() {
    // Desconectar e liberar nós de áudio
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch(e) {}
        sourceNode = null;
    }
    
    if (analyserNode) {
        try { analyserNode.disconnect(); } catch(e) {}
        analyserNode = null;
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
    if (socket && socket.connected) {
        socket.emit('stop_recording');
    }
}

// Funções para gerenciar reprodução de áudio da IA
function handleAudioChunk(data) {
    if (!data || !data.audio) return;
    
    try {
        // Decodificar Base64 para ArrayBuffer
        const binaryString = atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Adicionar à fila de chunks
        audioQueue.push(bytes.buffer);
        
        // Se é o primeiro chunk, iniciar reprodução imediatamente
        if (!isPlayingQueue) {
            // Ativar indicador visual
            isAISpeaking = true;
            updateSpeakingIndicators();
            
            // Iniciar reprodução sem delay
            playNextAudioChunk();
        }
    } catch (error) {
        console.error("Erro ao processar chunk de áudio:", error);
    }
}

function handleAudioStreamEnd() {
    console.log("Fim do stream de áudio");
    audioStreamEnded = true;
    
    // Reproduzir chunks restantes
    if (!isPlayingQueue && audioQueue.length > 0) {
        playNextAudioChunk();
    } else if (audioQueue.length === 0) {
        // Não há mais áudio para reproduzir
        finishAudioPlayback();
    }
}

function playNextAudioChunk() {
    if (audioQueue.length === 0) {
        if (audioStreamEnded) {
            finishAudioPlayback();
        }
        return;
    }
    
    isPlayingQueue = true;
    
    try {
        // Preparar os chunks para reprodução (até 3 de cada vez para maior fluidez)
        let currentChunkBuffers = [];
        let totalLength = 0;
        
        const maxChunksToProcess = Math.min(audioQueue.length, 3);
        
        for (let i = 0; i < maxChunksToProcess; i++) {
            const buffer = audioQueue.shift();
            currentChunkBuffers.push(buffer);
            totalLength += buffer.byteLength;
        }
        
        // Criar buffer contíguo
        const audioData = new Uint8Array(totalLength);
        let offset = 0;
        
        currentChunkBuffers.forEach(buffer => {
            audioData.set(new Uint8Array(buffer), offset);
            offset += buffer.byteLength;
        });
        
        // Criar WAV
        const wavHeader = createWavHeader(audioData.byteLength, 24000);
        const wavBuffer = new Uint8Array(wavHeader.byteLength + audioData.byteLength);
        wavBuffer.set(new Uint8Array(wavHeader), 0);
        wavBuffer.set(audioData, wavHeader.byteLength);
        
        // Decodificar e reproduzir
        audioContext.decodeAudioData(wavBuffer.buffer, (audioBuffer) => {
            // Agendar reprodução
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);
            
            // Armazenar info para controle
            const audioInfo = {
                source: source,
                startTime: nextPlayTime,
                duration: audioBuffer.duration
            };
            
            audioBufferQueue.push(audioInfo);
            
            // Iniciar reprodução no tempo agendado
            source.start(nextPlayTime);
            
            // Atualizar próximo tempo de reprodução
            nextPlayTime = nextPlayTime > 0 
                ? nextPlayTime + audioBuffer.duration 
                : audioContext.currentTime + audioBuffer.duration;
            
            // Configurar evento ao terminar
            source.onended = () => {
                // Remover da fila
                const index = audioBufferQueue.indexOf(audioInfo);
                if (index !== -1) {
                    audioBufferQueue.splice(index, 1);
                }
                
                // Se ainda há chunks, continuar reprodução
                if (audioQueue.length > 0 || !audioStreamEnded) {
                    // Processar próximo chunk após pequeno delay para melhor fluidez
                    setTimeout(() => {
                        playNextAudioChunk();
                    }, 10); // Delay mínimo para evitar travamentos
                } else if (audioBufferQueue.length === 0) {
                    // Não há mais áudio para reproduzir
                    finishAudioPlayback();
                }
            };
            
        }, (error) => {
            console.error("Erro ao decodificar áudio:", error);
            // Tentar próximo chunk
            setTimeout(() => {
                playNextAudioChunk();
            }, 10);
        });
        
    } catch (error) {
        console.error("Erro ao processar áudio:", error);
        setTimeout(() => {
            playNextAudioChunk();
        }, 10);
    }
}

function finishAudioPlayback() {
    console.log("Finalizada reprodução de áudio");
    
    // Resetar estado
    isPlayingQueue = false;
    audioStreamEnded = false;
    nextPlayTime = 0;
    audioQueue = [];
    
    // Atualizar interface
    isAISpeaking = false;
    updateSpeakingIndicators();
    
    // Resetar visualizador da IA
    const bars = aiVisualizer.querySelectorAll('.bar');
    bars.forEach(bar => {
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
    });
}

function resetAudioPlayback() {
    // Parar todas as fontes de áudio em reprodução
    audioBufferQueue.forEach(item => {
        try {
            item.source.stop();
        } catch (e) {
            // Ignorar erros se já parou
        }
    });
    
    // Limpar filas
    audioBufferQueue = [];
    audioQueue = [];
    isPlayingQueue = false;
    audioStreamEnded = false;
    nextPlayTime = 0;
    
    // Resetar estados
    isAISpeaking = false;
    updateSpeakingIndicators();
    
    // Resetar visualizadores
    const userBars = userVisualizer.querySelectorAll('.bar');
    const aiBars = aiVisualizer.querySelectorAll('.bar');
    
    userBars.forEach(bar => {
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
    });
    
    aiBars.forEach(bar => {
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
    });
}

// Funções auxiliares para criação de WAV
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

// Converter ArrayBuffer para Base64
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Tratamento de texto e transcrição
function handleTextChunk(data) {
    if (!data || !data.text) return;
    
    // Se é o primeiro chunk de uma nova resposta
    if (!conversationHistory.includes("IA:") || !isAISpeaking) {
        // Adicionar linha de transcrição do usuário se tiver
        if (isUserSpeaking || conversationHistory === "") {
            conversationHistory += conversationHistory ? "\n\n" : "";
            conversationHistory += "Você: ";
            
            // Se usuário estava falando, adicionar reticências
            if (isUserSpeaking) {
                conversationHistory += "...";
            }
            
            conversationHistory += "\n\nIA: ";
        } else if (!conversationHistory.endsWith("IA: ")) {
            conversationHistory += "\n\nIA: ";
        }
    }
    
    // Adicionar o texto ao histórico
    conversationHistory += data.text;
    
    // Atualizar o elemento de transcrição
    transcriptElement.textContent = conversationHistory;
    
    // Manter o scroll no final
    transcriptElement.scrollTop = transcriptElement.scrollHeight;
}

// Manipuladores de eventos da API
function handleSpeechStarted() {
    console.log("Fala detectada");
    isUserSpeaking = true;
    updateSpeakingIndicators();
}

function handleSpeechStopped() {
    console.log("Fim da fala detectado");
    isUserSpeaking = false;
    updateSpeakingIndicators();
    
    // Adicionar ... para indicar processamento
    if (!conversationHistory.includes("IA:") || !isAISpeaking) {
        if (conversationHistory === "") {
            conversationHistory = "Você: ...\n\n";
        } else if (!conversationHistory.endsWith("...")) {
            conversationHistory = conversationHistory.trim() + "...";
        }
        
        transcriptElement.textContent = conversationHistory;
    }
}

function handleProcessingStarted() {
    console.log("Processando solicitação");
    // Visual de processamento, se necessário
}

function handleResponseStarting() {
    console.log("Preparando resposta");
    // Preparar-se para receber áudio/texto
}

function handleError(data) {
    const errorMessage = data && data.error ? data.error : "Erro desconhecido";
    console.error("Erro:", errorMessage);
    
    showSystemMessage(errorMessage, 'error');
    
    // Parar processamento se houver erro
    stopAudioProcessing();
    resetAudioPlayback();
    
    // Voltar ao estado inicial
    isUserSpeaking = false;
    isAISpeaking = false;
    updateSpeakingIndicators();
}

// Inicializar ao carregar a página
window.addEventListener('load', initialize);