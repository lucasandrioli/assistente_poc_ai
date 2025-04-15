// poc.js (v11 - OpenAI S2S - Debug onmessage)

// --- Elementos da Página ---
const recordButton = document.getElementById('recordButton');
const statusDiv = document.getElementById('status');
const transcriptDiv = document.getElementById('transcript'); 
const serverUrl = 'http://localhost:5000';

// --- Variáveis de Estado ---
let audioContext = null;
let socket = null;
let isRecording = false;
let localStream = null; 
let sourceNode = null; 
let processorNode = null; 

// --- Variáveis para Playback de Áudio Streaming ---
let audioQueue = [];
let isPlayingQueue = false;
let expectedInputSampleRate = 24000; 
let expectedOutputSampleRate = 24000; 
let audioPlayingSource = null;

// --- Inicialização ---
async function initialize() {
    console.log("Inicializando..."); 
    setStatus('Carregando...', false); recordButton.disabled = true; 
    
    // 1. Verificar suporte
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioContext || !(new AudioContext()).audioWorklet) {
        setStatus("Erro: APIs de Áudio Web não suportadas.", false); console.error("getUserMedia/AudioContext/AudioWorklet não suportado."); recordButton.disabled = true; return;
    }
    
    // 2. Criar AudioContext e carregar módulo
    try {
        console.log("Criando AudioContext...");
        audioContext = new AudioContext({ sampleRate: expectedInputSampleRate });
        console.log(`AudioContext criado. Taxa de amostragem REAL: ${audioContext.sampleRate}Hz (Esperado: ${expectedInputSampleRate}Hz)`);
        if(audioContext.sampleRate !== expectedInputSampleRate) { console.warn(`AVISO: AudioContext usa ${audioContext.sampleRate}Hz.`); }
        if (audioContext.state === 'suspended') { console.warn("AudioContext suspenso."); }
        if (!audioContext.audioWorklet) { throw new Error("AudioWorklet não suportado."); }
        
        console.log("Carregando módulo AudioWorklet 'pcm-processor.js'...");
        await audioContext.audioWorklet.addModule('pcm-processor.js');
        console.log("Módulo AudioWorklet carregado."); 

    } catch(e) { 
        setStatus("Erro ao inicializar áudio.", false); 
        console.error("Erro na inicialização do áudio:", e); 
        recordButton.disabled = true; 
        return; 
    }

    console.log("ANTES de tentar conectar WebSocket.");
    
    // 3. Conectar via Socket.IO
    try {
        setStatus('Conectando ao servidor...', false); 
        recordButton.disabled = true; 
        connectWebSocket(); 
    } catch(e) {
         console.error("Erro ao chamar connectWebSocket ou setStatus:", e);
         setStatus("Erro na inicialização da conexão.", false);
    }
}

// --- Conexão WebSocket com o Backend Python ---
function connectWebSocket() {
    console.log("DENTRO de connectWebSocket(). Tentando conectar ao Socket.IO em", serverUrl);
    if (socket) { console.log("Desconectando socket anterior..."); socket.disconnect(); }
    socket = io(serverUrl, { transports: ['websocket'], reconnectionAttempts: 3 });

    socket.on('connect', () => { 
        console.log('Socket.IO conectado!', socket.id); 
        setStatus('Clique para falar', false); 
        recordButton.disabled = false; 
        recordButton.onclick = toggleRecording; // Define handler do botão AQUI
    });
    socket.on('disconnect', (reason) => { 
        console.warn('Socket.IO desconectado:', reason); 
        setStatus('Desconectado.', false); 
        recordButton.disabled = true; 
        recordButton.onclick = null; // Remove handler
        stopRecording(); // Garante parar gravação se houver
    });
    socket.on('connect_error', (error) => { 
        console.error('Erro conexão Socket.IO:', error); 
        setStatus('Erro ao conectar ao servidor.', false); 
        recordButton.disabled = true; 
        recordButton.onclick = null; // Remove handler
    });

    // Handlers de eventos da aplicação
    socket.on('audio_chunk', handleAudioChunk);
    socket.on('audio_stream_end', handleAudioStreamEnd);
    socket.on('text_chunk', handleTextChunk); 
    socket.on('processing_error', handleError);
    socket.on('initialization_error', handleError);
}

// --- Tratamento de Eventos de Streaming Vindos do Backend ---
function handleAudioChunk(data) { 
    console.log("[POC.JS] Recebido audio_chunk (Base64 início):", data.audio.substring(0, 60) + "...");
    if (data && data.audio) { 
        try { 
            const b = atob(data.audio); 
            const l = b.length; 
            const buffer = new ArrayBuffer(l);
            const B = new Uint8Array(buffer); 
            for(let i=0; i<l; i++){ B[i] = b.charCodeAt(i); } 
            audioQueue.push(buffer); 
        } catch (e) { 
            console.error("Erro decode audio chunk:", e); 
        } 
    } 
}
function handleAudioStreamEnd() { 
    console.log("Fim stream áudio recebido."); 
    playConcatenatedAudio(); 
}
function handleTextChunk(data) { 
    if(data && data.text){ 
        transcriptDiv.textContent = `IA: ${data.text}`; 
    } 
} 
function handleError(data) { 
    const e = data && data.error ? data.error : 'Erro'; 
    console.error('Erro backend:', e); 
    setStatus(`Erro: ${e}`, false); 
    resetAudioPlayback(); 
    stopRecording(); 
    recordButton.disabled = !(socket && socket.connected); 
}


// --- Lógica de Gravação de Áudio (AudioWorklet) ---
async function toggleRecording() {
    console.log(`[DEBUG] toggleRecording chamado. isRecording: ${isRecording}`); 
    if (isRecording) { 
        console.log("[DEBUG] Chamando stopRecording()..."); 
        stopRecording(); 
    } else {
        if (!audioContext) { console.error("AudioContext não inicializado!"); setStatus("Erro áudio.", false); return; }
        if (audioContext.state === 'suspended') { 
            try { 
                console.log("[DEBUG] Resumindo AudioContext..."); 
                await audioContext.resume(); 
                console.log("AudioContext resumido."); 
                console.log("[DEBUG] Chamando startRecording() após resumir..."); 
                startRecording(); 
            } catch (e) { console.error("Erro ao resumir AudioContext:", e); setStatus("Falha ao ativar áudio.", false); } 
        } else { 
            console.log("[DEBUG] Chamando startRecording() diretamente..."); 
            startRecording(); 
        }
    }
}

async function startRecording() {
    if (!socket || !socket.connected) { setStatus("Sem conexão.", false); return; }
    if (isRecording) return;
    transcriptDiv.textContent = '(Gravando...)'; 
    resetAudioPlayback(); 
    stopAudioPlayback(); 
    try {
        console.log("[DEBUG] Pedindo permissão do microfone..."); 
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("[DEBUG] Permissão OK. Configurando nós de áudio...");
        sourceNode = audioContext.createMediaStreamSource(localStream);
        processorNode = new AudioWorkletNode(audioContext, 'pcm-processor');
        console.log("[DEBUG] AudioWorkletNode criado.");

        // Handler para mensagens vindas do processador (pcm-processor.js)
        processorNode.port.onmessage = (event) => {
            // ***** NOVO: Log para verificar se o handler é chamado *****
            console.log("[POC.JS] processorNode.port.onmessage RECEBEU DADOS:", event.data); 
            // ************************************************************

            if (event.data.pcmData && socket && socket.connected) {
                const pcmInt16ArrayBuffer = event.data.pcmData;
                // Usando FileReader para Base64
                arrayBufferToBase64(pcmInt16ArrayBuffer).then(base64Audio => {
                    // console.log(`[POC.JS] Enviando chunk Base64: ${base64Audio.length} chars`);
                    console.log(`[POC.JS] Base64 Gerado (início): ${base64Audio.substring(0, 50)}...`);
                    console.log("[POC.JS] TENTANDO emitir chunk...");
                    socket.emit('audio_input_chunk', { audio: base64Audio });
                }).catch(err => console.error("Erro arrayBufferToBase64:", err));
            } else if (!socket || !socket.connected){ 
                console.warn("Socket desconectado, não enviando chunk."); 
            }
        };
        processorNode.onerror = (event) => { 
            console.error("Erro no AudioWorkletProcessor:", event); 
            setStatus("Erro no processamento de áudio.", false); 
            stopRecording(); 
        };
        sourceNode.connect(processorNode); 
        isRecording = true; 
        console.log("[DEBUG] Gravação iniciada via AudioWorklet.");
        if (socket && socket.connected) { 
            console.log("[DEBUG] Emitindo 'start_recording'."); 
            socket.emit('start_recording', { sampleRate: audioContext.sampleRate }); 
        }
        setStatus('Gravando... (Clique para parar)', false); 
        recordButton.classList.add('recording'); 
        recordButton.title = "Clique para parar"; 
        recordButton.innerHTML = '<span>&#9209;</span>'; 
    } catch (err) { 
        console.error("Erro startRecording:", err); 
        setStatus(`Erro microfone: ${err.message}`, false); 
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") { 
            setStatus("Permissão negada.", false); 
        } 
        stopRecording(); 
    }
}

function stopRecording() {
    console.log(`[DEBUG] stopRecording chamado. Estado processorNode: ${processorNode ? 'existe' : 'null'}`);
    if (sourceNode) { try { sourceNode.disconnect(); } catch(e) {} sourceNode = null; console.log("[DEBUG] Source desconectado."); }
    if (processorNode) { try { processorNode.disconnect(); } catch(e) {} processorNode = null; console.log("[DEBUG] Processor desconectado."); }
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; console.log("[DEBUG] Stream local parado."); }
    if (socket && socket.connected && isRecording) { console.log("[DEBUG] Emitindo 'stop_recording'."); socket.emit('stop_recording'); }
    isRecording = false; 
    recordButton.classList.remove('recording'); 
    recordButton.title = (socket && socket.connected) ? "Clique para falar" : "Indisponível"; 
    recordButton.innerHTML = '<span>&#127908;</span>'; 
    console.log("[DEBUG] stopRecording finalizado.");
}

// Função auxiliar para converter ArrayBuffer em Base64 usando FileReader
function arrayBufferToBase64(buffer) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer]); 
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64data = reader.result;
            const base64String = base64data.split(',')[1];
            resolve(base64String);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob); 
    });
}

// --- Playback de Áudio PCM Concatenado ---
function resetAudioPlayback() { 
    console.log("Resetando playback."); 
    audioQueue = []; 
    isPlayingQueue = false; 
    stopAudioPlayback(); 
}
function stopAudioPlayback() { 
    if (audioPlayingSource) { 
        try { 
            audioPlayingSource.onended = null; 
            audioPlayingSource.stop(); 
            console.log("Playback parado."); 
        } catch(e) {} 
        audioPlayingSource = null; 
    } 
    isPlayingQueue = false; 
}
async function playConcatenatedAudio() { 
    if (audioQueue.length === 0 || isPlayingQueue) { 
        if(audioQueue.length === 0 && !isRecording) { 
            setStatus('Clique para falar', false); 
            recordButton.disabled = !(socket && socket.connected); 
        } 
        return; 
    } 
    isPlayingQueue = true; 
    setStatus('Processando áudio...', true); 
    console.log(`Processando ${audioQueue.length} chunks...`);
    
    // Pequeno timeout para garantir que todos os chunks pendentes cheguem
    await new Promise(resolve => setTimeout(resolve, 50)); 

    try {
        let totalLength = 0; 
        audioQueue.forEach(b => { totalLength += b.byteLength; }); 
        if (totalLength === 0) { 
            console.warn("Áudio vazio."); 
            resetAudioPlayback(); 
            setStatus('Sem áudio.', false); 
            recordButton.disabled = !(socket && socket.connected); 
            return; 
        }
        const pcm = new Uint8Array(totalLength); 
        let offset = 0; 
        audioQueue.forEach(b => { pcm.set(new Uint8Array(b), offset); offset += b.byteLength; }); 
        console.log(`PCM: ${pcm.byteLength} bytes.`); 
        audioQueue = [];
        
        const header = createWavHeader(pcm.byteLength, expectedOutputSampleRate); 
        const wav = new Uint8Array(header.byteLength + pcm.byteLength); 
        wav.set(new Uint8Array(header), 0); 
        wav.set(pcm, header.byteLength); 
        console.log(`WAV: ${wav.byteLength} bytes.`);
        
        if (!audioContext || audioContext.state !== 'running') { 
            console.warn("AudioContext não pronto para playback..."); 
            if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: expectedOutputSampleRate }); 
            await audioContext.resume(); 
            if (audioContext.state !== 'running') throw new Error("AudioContext não iniciou."); 
        }
        
        console.log("Decodificando WAV..."); 
        setStatus('Tocando resposta...', false); 
        
        const audioBuffer = await audioContext.decodeAudioData(wav.buffer); 
        console.log("Tocando..."); 
        stopAudioPlayback(); // Para qualquer áudio anterior
        audioPlayingSource = audioContext.createBufferSource(); 
        audioPlayingSource.buffer = audioBuffer; 
        audioPlayingSource.connect(audioContext.destination);
        audioPlayingSource.onended = () => { 
            console.log("Playback WAV finalizado."); 
            audioPlayingSource = null; 
            isPlayingQueue = false; 
            setStatus('Clique para falar', false); 
            recordButton.disabled = !(socket && socket.connected); 
        }; 
        audioPlayingSource.start(0);
    } catch (error) { 
        setStatus('Erro ao tocar áudio.', false); 
        console.error('Erro playConcatenatedAudio:', error); 
        resetAudioPlayback(); 
        recordButton.disabled = !(socket && socket.connected); 
    }
}
function createWavHeader(dataLength, sampleRate, numChannels = 1, bitsPerSample = 16) { 
    const blockAlign = numChannels * bitsPerSample / 8; 
    const byteRate = sampleRate * blockAlign; 
    const buffer = new ArrayBuffer(44); 
    const view = new DataView(buffer); 
    writeString(view, 0, 'RIFF'); 
    view.setUint32(4, 36 + dataLength, true); 
    writeString(view, 8, 'WAVE'); 
    writeString(view, 12, 'fmt '); 
    view.setUint32(16, 16, true); 
    view.setUint16(20, 1, true); 
    view.setUint16(22, numChannels, true); 
    view.setUint32(24, sampleRate, true); 
    view.setUint32(28, byteRate, true); 
    view.setUint16(32, blockAlign, true); 
    view.setUint16(34, bitsPerSample, true); 
    writeString(view, 36, 'data'); 
    view.setUint32(40, dataLength, true); 
    return buffer; 
}
function writeString(view, offset, string) { 
    for(let i = 0; i < string.length; i++){ 
        view.setUint8(offset + i, string.charCodeAt(i)); 
    } 
}

// --- Status Update Helper ---
function setStatus(message, showProcessingIndicator) {
    statusDiv.innerHTML = ''; 
    statusDiv.textContent = message; 
    if (showProcessingIndicator) { 
        const i = document.createElement('span'); 
        i.className = 'processing-indicator dot-flashing'; 
        statusDiv.appendChild(i); 
    }
    const isBusyCritically = isPlayingQueue || message.includes('Tocando') || message.includes('Enviando') || message.includes('Conectando') || showProcessingIndicator || message.includes('Processando');
    const canInteract = socket && socket.connected && (isRecording || !isBusyCritically);
    recordButton.disabled = !canInteract; 
    if (isRecording) { 
        recordButton.classList.add('recording'); 
        recordButton.title = "Clique para parar"; 
        recordButton.innerHTML = '<span>&#9209;</span>'; 
    } else { 
        recordButton.classList.remove('recording'); 
        recordButton.innerHTML = '<span>&#127908;</span>'; 
        if (canInteract) { 
            recordButton.title = "Clique para falar"; 
        } else { 
            recordButton.title = (socket && socket.connected) ? "Processando/Tocando..." : "Indisponível"; 
        } 
    }
}

// --- Iniciar ---
initialize();