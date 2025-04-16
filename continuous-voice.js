// continuous-voice.js - Implementação otimizada de chamada de voz contínua com IA

// --- Elementos da Interface ---
const callStatusElement = document.querySelector('.call-status');
const userIndicator = document.querySelector('.user-indicator');
const aiIndicator = document.querySelector('.ai-indicator');
const userVisualizer = document.querySelector('.user-visualizer');
const aiVisualizer = document.querySelector('.ai-visualizer');
const transcriptElement = document.getElementById('transcript');
const toggleCallButton = document.getElementById('toggle-call');
const toggleMuteButton = document.getElementById('toggle-mute');
const endCallButton = document.getElementById('end-call');

// --- Configurações ---
const SERVER_URL = window.location.origin; // Assume que o servidor está na mesma origem
const EXPECTED_SAMPLE_RATE = 24000; // Taxa de amostragem esperada do áudio da IA (OpenAI padrão)
const BARS_COUNT = 30; // Número de barras no visualizador
const MIN_BAR_HEIGHT = 5; // Altura mínima das barras (px)
const MAX_BAR_HEIGHT = 50; // Altura máxima das barras (px)
const USER_SPEAKING_THRESHOLD = 25; // Limiar de volume para ativar visualizador do usuário (0-255)

// --- Estado da Aplicação ---
let audioContext = null; // Contexto de áudio principal
let analyserNode = null; // Nó para análise de frequência (visualização)
let socket = null; // Conexão WebSocket (Socket.IO)
let localStream = null; // Stream do microfone do usuário
let sourceNode = null; // Nó fonte do microfone
let scriptProcessorNode = null; // Nó para processamento de áudio (Captura) - **DEPRECATED**
let isCallActive = false; // Indica se a chamada está ativa
let isMuted = false; // Indica se o microfone do usuário está mudo
let isAISpeaking = false; // Indica se a IA está enviando áudio
let isUserVisuallySpeaking = false; // Indica se o visualizador do usuário deve estar ativo (baseado em volume)
let audioQueue = []; // Fila para chunks de áudio recebidos da IA (ArrayBuffer)
let audioBufferQueue = []; // Fila para AudioBuffers decodificados e prontos para tocar
let isPlayingQueue = false; // Indica se a fila de áudio da IA está sendo reproduzida
let nextPlayTime = 0; // Próximo tempo agendado para tocar áudio da IA
let audioStreamEnded = true; // Indica se o servidor sinalizou o fim do stream de áudio da IA
let consecutiveChunks = 0; // Contador de chunks de áudio recebidos rapidamente
let lastChunkTime = 0; // Timestamp do último chunk recebido
let conversationHistory = ""; // Histórico da conversa para exibição

// Configuração de VAD (padrão inicial, pode ser atualizada)
let vadConfig = {
    type: "semantic_vad",   // Usar o VAD semântico da OpenAI
    eagerness: "medium",    // Configuração padrão balanceada
    create_response: true,  // Criar resposta automaticamente após fim de fala do usuário
    interrupt_response: true // Permitir que a fala do usuário interrompa a resposta da IA
};

// --- Funções de Interface e Visualização ---

/**
 * Cria as barras iniciais para os visualizadores de áudio.
 */
function setupVisualizers() {
    // Limpar visualizadores existentes (caso a função seja chamada novamente)
    userVisualizer.innerHTML = '';
    aiVisualizer.innerHTML = '';

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
    console.debug("Visualizadores configurados.");
}

/**
 * Atualiza o elemento de status da chamada na interface.
 * @param {string} status - Classe CSS ('connecting', 'active', 'disconnected', 'error').
 * @param {string} message - Mensagem a ser exibida.
 */
function updateCallStatus(status, message) {
    callStatusElement.className = `call-status ${status}`;
    callStatusElement.innerHTML = `<div class="pulse-dot"></div><span>${message}</span>`;
    console.log(`Status da chamada: ${status} - ${message}`);
}

/**
 * Mostra uma mensagem temporária do sistema na área de transcrição.
 * @param {string} message - Mensagem a ser exibida.
 * @param {string} [type='info'] - Tipo da mensagem ('info', 'success', 'warning', 'error').
 */
function showSystemMessage(message, type = 'info') {
    let messageElement = document.querySelector('.system-message');

    // Cria o elemento se não existir
    if (!messageElement) {
        messageElement = document.createElement('div');
        // Insere antes do elemento de transcrição para ficar no topo
        transcriptElement.parentNode.insertBefore(messageElement, transcriptElement);
    }

    // Define classe e conteúdo
    messageElement.className = `system-message ${type}`;
    messageElement.textContent = message;
    console.log(`Mensagem do sistema (${type}): ${message}`);

    // Remover após 3 segundos
    setTimeout(() => {
        if (messageElement && messageElement.parentNode) {
            messageElement.parentNode.removeChild(messageElement);
        }
    }, 3000);
}

/**
 * Atualiza os indicadores visuais de quem está falando (usuário/IA).
 */
function updateSpeakingIndicators() {
    // Usa 'isUserVisuallySpeaking' para o indicador do usuário (baseado em volume)
    userIndicator.classList.toggle('active', isUserVisuallySpeaking);
    // Usa 'isAISpeaking' para o indicador da IA (baseado em recebimento de áudio)
    aiIndicator.classList.toggle('active', isAISpeaking);
}

/**
 * Anima as barras do visualizador do usuário com base nos dados de frequência.
 * @param {Uint8Array} audioData - Dados de frequência do AnalyserNode.
 */
function animateUserVisualizer(audioData) {
    const bars = userVisualizer.querySelectorAll('.bar');
    if (!bars.length) return; // Sai se as barras não foram criadas

    const barCount = bars.length;

    for (let i = 0; i < barCount; i++) {
        // Mapeia o índice da barra para o índice do array de dados
        const index = Math.floor(i * audioData.length / barCount);
        // Normaliza o valor (0 a 1)
        const value = audioData[index] / 255.0;
        // Calcula a altura da barra
        const height = MIN_BAR_HEIGHT + value * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
        bars[i].style.height = `${height}px`;
    }
}

/**
 * Anima as barras do visualizador da IA com valores aleatórios enquanto a IA fala.
 */
function animateAIVisualizer() {
    if (!isAISpeaking) return; // Anima apenas se a IA estiver falando

    const bars = aiVisualizer.querySelectorAll('.bar');
    if (!bars.length) return;

    // Animação aleatória simples para simular a voz da IA
    for (let i = 0; i < bars.length; i++) {
        const randomValue = Math.random();
        const height = MIN_BAR_HEIGHT + randomValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
        bars[i].style.height = `${height}px`;
    }
}

// --- Configuração de VAD ---

/**
 * Configura o VAD semântico enviando a configuração para o servidor.
 * @param {string} [eagerness='medium'] - Nível de agressividade ('low', 'medium', 'high', 'auto').
 */
function configureSemanticVAD(eagerness = 'medium') {
    // Validar opção de eagerness
    if (!['low', 'medium', 'high', 'auto'].includes(eagerness)) {
        console.warn(`Eagerness inválido '${eagerness}', usando 'medium'.`);
        eagerness = 'medium'; // Valor padrão se inválido
    }

    // Atualizar configuração local
    vadConfig = {
        type: "semantic_vad",
        eagerness: eagerness,
        create_response: true, // Manter padrões para outras opções
        interrupt_response: true
    };

    // Enviar configuração atualizada para o servidor se estiver conectado
    if (socket && socket.connected) {
        socket.emit('update_vad_config', vadConfig);
        console.log(`Enviando configuração VAD para o servidor: ${JSON.stringify(vadConfig)}`);
        showSystemMessage(`Modo de escuta: ${getEagernessDescription(eagerness)}`, 'info');
    } else {
        console.log(`VAD configurado localmente para eagerness: ${eagerness} (será enviado na conexão)`);
    }
}

/**
 * Retorna uma descrição textual para o nível de eagerness do VAD.
 * @param {string} eagerness - Nível de eagerness.
 * @returns {string} Descrição.
 */
function getEagernessDescription(eagerness) {
    switch(eagerness) {
        case 'low':
            return 'Paciente (espera pausas longas)';
        case 'high':
            return 'Responsivo (responde rapidamente)';
        case 'auto': // 'auto' pode se comportar como 'medium' ou variar
        case 'medium':
        default:
            return 'Balanceado';
    }
}

// --- Inicialização e Controles Principais ---

/**
 * Inicializa a aplicação, configura visualizadores e handlers de eventos.
 */
async function initialize() {
    console.log("Inicializando assistente de voz contínuo...");
    setupVisualizers();

    try {
        // Verificar suporte a APIs essenciais
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Seu navegador não suporta a API MediaDevices (getUserMedia).");
        }
        if (!window.AudioContext) {
            throw new Error("Seu navegador não suporta a API Web Audio (AudioContext).");
        }
         if (!window.io) {
            throw new Error("Biblioteca Socket.IO não encontrada. Verifique a inclusão no HTML.");
        }

        // Criar contexto de áudio (pode iniciar suspenso)
        // Tenta criar com a taxa de amostragem esperada da IA para evitar resampling na saída
        try {
             audioContext = new AudioContext({ sampleRate: EXPECTED_SAMPLE_RATE });
             console.log(`AudioContext criado com taxa preferencial: ${audioContext.sampleRate}Hz`);
        } catch (e) {
            console.warn(`Não foi possível criar AudioContext com ${EXPECTED_SAMPLE_RATE}Hz, usando padrão do sistema.`, e);
            audioContext = new AudioContext();
             console.log(`AudioContext criado com taxa padrão: ${audioContext.sampleRate}Hz`);
        }


        // Configurar handlers de eventos para os botões
        toggleCallButton.addEventListener('click', toggleCall);
        toggleMuteButton.addEventListener('click', toggleMute);
        endCallButton.addEventListener('click', endCall);

        // Iniciar com status de desconectado e botões no estado correto
        updateCallStatus('disconnected', 'Desconectado');
        updateButtonStates(); // Garante estado inicial correto dos botões

        // Configurar animação contínua para visualizador da IA (roda a cada 100ms)
        setInterval(animateAIVisualizer, 100);

        // Adicionar controles de VAD na interface
        setupVADControls();

        // Adicionar botões de Limpar e Salvar
        setupClearButton();
        setupSaveButton();

        showSystemMessage("Sistema pronto. Clique em Iniciar Chamada para começar.", "success");

    } catch (error) {
        console.error("Erro fatal na inicialização:", error);
        showSystemMessage(`Erro na inicialização: ${error.message}. Verifique o console.`, 'error');
        // Desabilitar botões se a inicialização falhar
        toggleCallButton.disabled = true;
        toggleMuteButton.disabled = true;
        endCallButton.disabled = true;
    }
}

/**
 * Adiciona os botões de controle do VAD (eagerness) à interface.
 */
function setupVADControls() {
    // Evita adicionar controles duplicados
    if (document.querySelector('.vad-controls')) return;

    // Criar container para controles
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'vad-controls';
    // Usar textContent para segurança contra XSS
    controlsContainer.innerHTML = `
        <div class="vad-label">Modo de escuta:</div>
        <div class="vad-options">
            <button class="vad-option" data-eagerness="low">Paciente</button>
            <button class="vad-option active" data-eagerness="medium">Balanceado</button> <button class="vad-option" data-eagerness="high">Responsivo</button>
        </div>
    `;

    // Inserir antes dos controles principais da chamada
    const mainControls = document.querySelector('.controls');
    if (mainControls) {
        mainControls.parentNode.insertBefore(controlsContainer, mainControls);
    } else {
        console.error("Container de controles principal não encontrado para inserir controles VAD.");
        return;
    }

    // Adicionar handlers de eventos aos botões de VAD
    const vadButtons = controlsContainer.querySelectorAll('.vad-option');
    vadButtons.forEach(button => {
        button.addEventListener('click', () => {
            // Atualizar interface (botão ativo)
            vadButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Configurar VAD com o valor selecionado
            const eagerness = button.getAttribute('data-eagerness');
            configureSemanticVAD(eagerness);
        });
    });
    console.debug("Controles VAD configurados.");
}

/**
 * Conecta ao servidor Socket.IO e configura os handlers de eventos.
 */
function connectToServer() {
    // Desconecta se já houver uma conexão ativa
    if (socket && socket.connected) {
        console.log("Desconectando socket existente antes de reconectar...");
        socket.disconnect();
    }

    updateCallStatus('connecting', 'Conectando...');
    console.log(`Tentando conectar ao servidor: ${SERVER_URL}`);

    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'], // Tenta WebSocket primeiro
        reconnectionAttempts: 3, // Tenta reconectar 3 vezes
        timeout: 10000 // Timeout de conexão de 10 segundos
    });

    // --- Handlers de Eventos do Socket.IO ---
    socket.on('connect', () => {
        console.log('Conexão estabelecida com o servidor. ID:', socket.id);
        updateCallStatus('active', 'Chamada ativa');
        showSystemMessage('Conectado ao servidor', 'success');

        // Enviar configuração VAD inicial após conexão bem-sucedida
        console.log("Enviando configuração VAD inicial:", vadConfig);
        socket.emit('update_vad_config', vadConfig);

        // Iniciar captura de áudio (se a chamada já estiver ativa logicamente)
        if (isCallActive) {
             startContinuousCapture();
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn('Desconectado do servidor. Razão:', reason);
        // Se a desconexão não foi intencional (pelo botão endCall), tenta reconectar ou informa erro.
        if (isCallActive) {
             updateCallStatus('disconnected', 'Conexão perdida');
             showSystemMessage(`Desconectado: ${reason}. Tentando reconectar...`, 'warning');
             // A biblioteca Socket.IO tentará reconectar automaticamente (reconnectionAttempts)
             // Se falhar, o estado permanecerá desconectado.
        } else {
            // Desconexão foi intencional (endCall)
             updateCallStatus('disconnected', 'Desconectado');
        }
        // Parar processos de áudio locais em caso de desconexão
        stopAudioProcessing();
        resetAudioPlayback();
        // Não mudar isCallActive aqui, pois pode ser uma desconexão temporária
    });

    socket.on('connect_error', (error) => {
        console.error('Erro de conexão com o servidor:', error);
        updateCallStatus('error', 'Erro de conexão');
        showSystemMessage(`Falha ao conectar: ${error.message}`, 'error');
        // Se falhar ao conectar inicialmente, reverter estado
        isCallActive = false;
        updateButtonStates();
        stopAudioProcessing();
        resetAudioPlayback();
    });

     socket.on('reconnect_attempt', (attempt) => {
        console.log(`Tentativa de reconexão #${attempt}...`);
        updateCallStatus('connecting', `Reconectando (${attempt})...`);
    });

    socket.on('reconnect_failed', () => {
        console.error('Falha ao reconectar ao servidor.');
        updateCallStatus('error', 'Falha na reconexão');
        showSystemMessage('Não foi possível reconectar ao servidor.', 'error');
        isCallActive = false; // Marcar chamada como inativa se a reconexão falhar
        updateButtonStates();
        stopAudioProcessing();
        resetAudioPlayback();
    });

    // --- Handlers de Eventos da Aplicação (Recebidos do Servidor) ---
    socket.on('audio_chunk', handleAudioChunk);
    socket.on('audio_stream_end', handleAudioStreamEnd);
    socket.on('text_chunk', handleTextChunk);
    socket.on('speech_started', handleSpeechStarted); // Fala do usuário detectada pelo VAD do servidor
    socket.on('speech_stopped', handleSpeechStopped); // Fim da fala do usuário detectado pelo VAD do servidor
    socket.on('processing_started', handleProcessingStarted); // IA começou a processar a fala do usuário
    socket.on('response_starting', handleResponseStarting); // IA começou a gerar/enviar a resposta
    socket.on('processing_error', handleError); // Erro durante o processamento no servidor
    socket.on('response_canceled', handleResponseCanceled); // Resposta da IA foi cancelada/interrompida
    socket.on('vad_config_updated', (data) => { // Confirmação de atualização do VAD
        if(data && data.success) {
            console.log("Configuração VAD confirmada pelo servidor:", data.config);
            // Opcional: Atualizar a interface se a configuração do servidor for diferente
            // const currentEagerness = vadConfig.eagerness;
            // if (data.config.eagerness !== currentEagerness) { ... }
        } else {
             console.warn("Falha ao atualizar configuração VAD no servidor.");
        }
    });
}

/**
 * Handler para evento 'response_canceled' do servidor.
 */
function handleResponseCanceled() {
    console.log("Servidor informou que a resposta foi cancelada/interrompida.");
    isAISpeaking = false;
    updateSpeakingIndicators();

    // Limpar buffers de áudio da IA que estavam na fila para tocar
    resetAudioPlayback();

    showSystemMessage("Resposta da IA interrompida.", "info");
     // Remover indicador de "pensando" ou "respondendo"
    hideThinkingIndicator();
    transcriptElement.classList.remove('ai-responding', 'response-starting');
}

// --- Controle da Chamada ---

/**
 * Alterna entre iniciar e pausar (mutar) a chamada.
 */
async function toggleCall() {
    if (isCallActive) {
        // Se a chamada está ativa, o botão agora funciona como Mute/Unmute
        toggleMute();
        // Atualiza o ícone para refletir o estado de mudo, não pausa/play
        toggleCallButton.innerHTML = isMuted
            ? '<i class="fas fa-microphone-slash"></i>'
            : '<i class="fas fa-microphone"></i>';
        toggleCallButton.title = isMuted ? 'Reativar Microfone' : 'Silenciar Microfone';
        toggleCallButton.className = 'control-button secondary'; // Mantém como secundário enquanto ativo

    } else {
        // Se a chamada está inativa, inicia a chamada
        await startCall();
    }
}


/**
 * Inicia a chamada: conecta ao servidor, solicita microfone e configura áudio.
 */
async function startCall() {
    if (isCallActive) return; // Evita iniciar múltiplas vezes

    console.log("Iniciando chamada...");
    updateCallStatus('connecting', 'Iniciando...');

    try {
        // Ativar AudioContext se estiver suspenso (necessário interação do usuário)
        if (audioContext.state === 'suspended') {
            console.log("AudioContext suspenso, tentando resumir...");
            await audioContext.resume();
            console.log("AudioContext resumido. Estado:", audioContext.state);
        }
        if (audioContext.state !== 'running') {
             throw new Error(`AudioContext não está rodando. Estado: ${audioContext.state}`);
        }

        // Solicitar acesso ao microfone
        console.log("Solicitando acesso ao microfone...");
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                // Tentar usar a taxa de amostragem do AudioContext se possível
                sampleRate: audioContext.sampleRate,
                // Opções de processamento de áudio (podem ajudar ou atrapalhar dependendo do navegador/hardware)
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        console.log("Acesso ao microfone concedido.");

         // Configurar processamento de áudio (APÓS obter o stream)
        setupAudioProcessing();

        // Marcar chamada como ativa *antes* de conectar para handlers de conexão saberem
        isCallActive = true;
        isMuted = false; // Começa não mutado
        updateButtonStates(); // Atualiza botões para estado ativo

        // Conectar ao servidor (agora que temos o áudio pronto)
        connectToServer(); // connectToServer chamará startContinuousCapture internamente após conectar

        showSystemMessage('Chamada iniciada. Fale quando quiser.', 'success');

    } catch (error) {
        console.error("Erro ao iniciar chamada:", error);
        let userMessage = `Erro ao iniciar chamada: ${error.message}`;
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            userMessage = 'Permissão de microfone negada. Habilite o acesso nas configurações do navegador.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
             userMessage = 'Nenhum microfone encontrado.';
        } else if (error.message.includes("AudioContext")) {
             userMessage = `Erro no sistema de áudio: ${error.message}. Tente recarregar a página.`;
        }

        showSystemMessage(userMessage, 'error');
        updateCallStatus('error', 'Erro ao iniciar');
        isCallActive = false; // Garante que o estado seja revertido
        updateButtonStates(); // Reverte botões
        stopAudioProcessing(); // Limpa recursos de áudio
        resetAudioPlayback();
    }
}

/**
 * Pausa a chamada (atualmente implementado como Mute).
 * A função toggleCall agora lida com isso. Esta função pode ser removida ou reimplementada
 * se uma pausa real (sem desconectar) for necessária.
 */
// function pauseCall() { ... } // Removida ou a ser reimplementada se necessário

/**
 * Encerra a chamada: para áudio, desconecta do servidor e reseta estados.
 */
function endCall() {
    if (!isCallActive) return; // Não faz nada se já não estiver ativa

    console.log("Encerrando chamada...");

    // Parar todos os processos de áudio locais
    stopAudioProcessing();
    resetAudioPlayback();

    // Desconectar do servidor
    if (socket && socket.connected) {
        console.log("Desconectando do servidor...");
        socket.disconnect(); // Isso acionará o handler 'disconnect'
    }

    // Atualizar estado da aplicação
    isCallActive = false;
    isUserVisuallySpeaking = false;
    isAISpeaking = false;
    isMuted = false; // Reseta estado de mudo
    updateSpeakingIndicators();
    updateButtonStates(); // Atualiza botões para estado inativo
    updateCallStatus('disconnected', 'Chamada encerrada');
    showSystemMessage('Chamada encerrada pelo usuário.', 'info');

    // Limpar visualizadores
    animateUserVisualizer(new Uint8Array(BARS_COUNT).fill(0)); // Zera visualizador do usuário
    const aiBars = aiVisualizer.querySelectorAll('.bar');
    aiBars.forEach(bar => bar.style.height = `${MIN_BAR_HEIGHT}px`); // Zera visualizador da IA
}

/**
 * Alterna o estado de mudo do microfone do usuário.
 */
function toggleMute() {
    if (!isCallActive) return; // Só funciona se a chamada estiver ativa

    isMuted = !isMuted;
    console.log(`Microfone ${isMuted ? 'silenciado' : 'ativado'}.`);

    // Atualizar visual do botão de mudo
    toggleMuteButton.innerHTML = isMuted
        ? '<i class="fas fa-microphone-slash"></i>' // Ícone de microfone cortado
        : '<i class="fas fa-microphone"></i>'; // Ícone de microfone normal
    toggleMuteButton.title = isMuted ? 'Reativar Microfone' : 'Silenciar Microfone';

    // Atualizar botão principal (toggleCall) para refletir estado de mudo
     toggleCallButton.innerHTML = isMuted
            ? '<i class="fas fa-microphone-slash"></i>'
            : '<i class="fas fa-microphone"></i>';
    toggleCallButton.title = isMuted ? 'Reativar Microfone' : 'Silenciar Microfone';


    // Habilitar/desabilitar as tracks de áudio do stream local
    // Isso efetivamente para/retoma o envio de áudio sem precisar mexer nos nós
    if (localStream) {
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !isMuted;
        });
        console.log(`Tracks de áudio ${!isMuted ? 'habilitadas' : 'desabilitadas'}.`);
    }

    // Mostrar mensagem de feedback
    showSystemMessage(isMuted ? 'Microfone silenciado' : 'Microfone ativado', 'info');

    // Se o usuário mutar, o visualizador deve parar
    if (isMuted) {
        isUserVisuallySpeaking = false;
        updateSpeakingIndicators();
        animateUserVisualizer(new Uint8Array(BARS_COUNT).fill(0)); // Zera visualizador
    }
}


/**
 * Atualiza a aparência e estado (habilitado/desabilitado) dos botões de controle.
 */
function updateButtonStates() {
    // Botão Principal (Iniciar/Mutar)
    toggleCallButton.disabled = false; // Geralmente sempre habilitado
    if (isCallActive) {
        toggleCallButton.className = 'control-button secondary'; // Botão secundário quando ativo
         toggleCallButton.innerHTML = isMuted
            ? '<i class="fas fa-microphone-slash"></i>' // Mostra estado de mudo
            : '<i class="fas fa-microphone"></i>';
        toggleCallButton.title = isMuted ? 'Reativar Microfone' : 'Silenciar Microfone';
    } else {
        toggleCallButton.className = 'control-button primary'; // Botão primário para iniciar
        toggleCallButton.innerHTML = '<i class="fas fa-phone"></i>'; // Ícone de telefone para iniciar
        toggleCallButton.title = 'Iniciar Chamada';
    }

    // Botão de Mudo (separado)
    toggleMuteButton.disabled = !isCallActive; // Habilitado apenas se a chamada estiver ativa
    toggleMuteButton.innerHTML = isMuted
        ? '<i class="fas fa-microphone-slash"></i>'
        : '<i class="fas fa-microphone"></i>';
     toggleMuteButton.title = isMuted ? 'Reativar Microfone' : 'Silenciar Microfone';


    // Botão de Encerrar
    endCallButton.disabled = !isCallActive; // Habilitado apenas se a chamada estiver ativa
}

// --- Processamento de Áudio (Entrada do Usuário) ---

/**
 * Configura os nós da Web Audio API para processar o áudio do microfone.
 */
function setupAudioProcessing() {
    if (!localStream || !audioContext) {
        console.error("Stream local ou AudioContext não disponíveis para setupAudioProcessing.");
        return;
    }
     if (sourceNode || scriptProcessorNode) {
        console.warn("Nós de áudio já existem. Limpando antes de recriar.");
        stopAudioProcessing(); // Garante limpeza antes de recriar
    }

    console.log("Configurando nós de processamento de áudio...");

    // 1. Criar nó fonte a partir do stream do microfone
    sourceNode = audioContext.createMediaStreamSource(localStream);

    // 2. Criar analisador para visualização
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256; // Tamanho da FFT (potência de 2) - influencia resolução da frequência
    analyserNode.smoothingTimeConstant = 0.6; // Suavização da visualização (0 a 1)

    // 3. Criar processador de script para captura de áudio
    // **AVISO:** createScriptProcessor é DEPRECATED e pode causar problemas de performance.
    // A alternativa moderna é usar AudioWorklet, mas é mais complexa de implementar.
    // Para este exemplo, mantemos o ScriptProcessorNode, cientes da limitação.
    const bufferSize = 4096; // Tamanho do buffer (amostras) - influencia latência
    scriptProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1); // bufferSize, inputChannels=1, outputChannels=1
     console.log(`ScriptProcessorNode criado com buffer size: ${bufferSize}`);


    // 4. Definir a função de callback 'onaudioprocess'
    scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        // Não processa se a chamada não estiver ativa ou se estiver mudo (track desabilitada)
        if (!isCallActive || !localStream.getAudioTracks()[0]?.enabled) {
             // Se estava falando visualmente, reseta
             if (isUserVisuallySpeaking) {
                isUserVisuallySpeaking = false;
                updateSpeakingIndicators();
                animateUserVisualizer(new Uint8Array(analyserNode.frequencyBinCount).fill(0));
             }
            return;
        }

        // --- Processamento para Visualização ---
        const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
        analyserNode.getByteFrequencyData(dataArray); // Pega dados de frequência

        // Detectar se o usuário está falando (nível de energia) para o *visualizador*
        const sum = dataArray.reduce((acc, val) => acc + val, 0);
        const average = sum / dataArray.length;
        const newIsUserVisuallySpeaking = average > USER_SPEAKING_THRESHOLD;

        // Atualiza o estado visual apenas se mudar
        if (newIsUserVisuallySpeaking !== isUserVisuallySpeaking) {
            isUserVisuallySpeaking = newIsUserVisuallySpeaking;
            updateSpeakingIndicators(); // Atualiza o indicador visual (bolinha)
        }

        // Animar visualizador de barras apenas se o usuário estiver falando visualmente
        if (isUserVisuallySpeaking) {
            animateUserVisualizer(dataArray);
        } else {
             // Zera o visualizador se não estiver falando
             animateUserVisualizer(new Uint8Array(analyserNode.frequencyBinCount).fill(0));
        }

        // --- Processamento para Envio ao Servidor ---
        // Captura os dados de áudio raw (Float32 -1.0 a 1.0)
        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);

        // Converter Float32 para Int16 (PCM16) - formato esperado pelo servidor
        const pcmBuffer = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i])); // Clamp
            // Converte para range de Int16
            pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Converter ArrayBuffer para Base64
        const base64Audio = arrayBufferToBase64(pcmBuffer.buffer);

        // Enviar para o servidor via Socket.IO se conectado
        // **IMPORTANTE:** Enviamos o áudio continuamente enquanto a chamada está ativa e não mutada.
        // O servidor usará o VAD para detectar início/fim de fala.
        if (socket && socket.connected) {
            // console.debug("Enviando chunk de áudio para o servidor."); // Log muito verboso
            socket.emit('audio_input_chunk', { audio: base64Audio });
        }
    };

    // 5. Conectar os nós em cadeia: source -> analyser -> scriptProcessor -> destination
    // O áudio vai para o analyser APENAS para visualização, não afeta o áudio enviado.
    // O áudio vai para o scriptProcessor para captura e envio.
    // Conectar scriptProcessor ao destination para evitar problemas em alguns navegadores (embora não produzamos som aqui).
    sourceNode.connect(analyserNode);
    sourceNode.connect(scriptProcessorNode);
    scriptProcessorNode.connect(audioContext.destination); // Conectar à saída padrão

    console.log("Nós de áudio conectados.");
}


/**
 * Notifica o servidor que a gravação (envio de áudio) foi iniciada.
 */
function startContinuousCapture() {
    if (socket && socket.connected) {
        console.log("Notificando servidor: start_recording");
        // Envia a taxa de amostragem real do AudioContext, pois o servidor pode precisar dela
        // embora o servidor vá fazer resampling para 16kHz de qualquer forma.
        socket.emit('start_recording', { sampleRate: audioContext.sampleRate });
    } else {
        console.warn("Tentativa de startContinuousCapture sem conexão com socket.");
    }
}

/**
 * Para o processamento de áudio local, desconecta nós e libera o microfone.
 */
function stopAudioProcessing() {
    console.log("Parando processamento de áudio local...");

    // Desconectar nós de áudio para liberar recursos
    if (sourceNode) {
        try { sourceNode.disconnect(); } catch(e) { console.debug("Erro ao desconectar sourceNode:", e); }
        sourceNode = null;
    }
    if (analyserNode) {
        try { analyserNode.disconnect(); } catch(e) { console.debug("Erro ao desconectar analyserNode:", e); }
        analyserNode = null;
    }
    if (scriptProcessorNode) {
         // Remover o callback para parar o processamento
        scriptProcessorNode.onaudioprocess = null;
        try { scriptProcessorNode.disconnect(); } catch(e) { console.debug("Erro ao desconectar scriptProcessorNode:", e); }
        scriptProcessorNode = null;
    }

    // Parar tracks do microfone para liberar o dispositivo
    if (localStream) {
        console.log("Parando tracks do stream local.");
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Notificar o servidor que paramos de enviar áudio (opcional, mas bom)
    // O servidor também detecta isso pelo fim do stream ou VAD.
    if (socket && socket.connected) {
        console.log("Notificando servidor: stop_recording");
        socket.emit('stop_recording');
    }

     // Resetar estado visual do usuário
    isUserVisuallySpeaking = false;
    updateSpeakingIndicators();
    animateUserVisualizer(new Uint8Array(BARS_COUNT).fill(0));

    console.log("Processamento de áudio local parado.");
}


// --- Processamento de Áudio (Saída da IA) ---

/**
 * Handler para receber chunks de áudio da IA vindos do servidor.
 * Adiciona o chunk decodificado à fila de reprodução.
 * @param {object} data - Objeto contendo o chunk de áudio em base64 (`data.audio`).
 */
function handleAudioChunk(data) {
    if (!data || !data.audio) {
        console.warn("Recebido chunk de áudio inválido ou vazio.");
        return;
    }
     if (!isCallActive) {
         console.log("Recebido chunk de áudio, mas a chamada não está ativa. Ignorando.");
         return;
     }

    // console.debug("Recebido chunk de áudio da IA."); // Log muito verboso

    try {
        // Registrar métricas de tempo entre chunks (para debug de latência)
        const now = Date.now();
        if (lastChunkTime > 0) {
            const timeBetweenChunks = now - lastChunkTime;
            // console.debug(`Tempo desde último chunk: ${timeBetweenChunks}ms`);
            // Lógica de agrupamento (consecutiveChunks) pode ser reativada se necessário
            consecutiveChunks = (timeBetweenChunks < 75) ? consecutiveChunks + 1 : 0;
        }
        lastChunkTime = now;

        // Decodificar Base64 para ArrayBuffer
        // Usar TextDecoder pode ser mais eficiente que atob para dados binários grandes
        const binaryString = atob(data.audio);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        const audioChunkBuffer = bytes.buffer;

        // Adicionar ArrayBuffer do chunk à fila de espera
        audioQueue.push(audioChunkBuffer);
        audioStreamEnded = false; // Recebemos um chunk, então o stream está ativo

        // Se a fila de reprodução não estiver ativa, inicia
        if (!isPlayingQueue) {
             // Define que a IA está falando (para indicador visual)
             if (!isAISpeaking) {
                isAISpeaking = true;
                updateSpeakingIndicators();
             }
            // Iniciar reprodução com um pequeno delay inicial para permitir que alguns chunks se acumulem
            // Ajuda a evitar som "picotado" se os chunks iniciais forem muito pequenos ou a rede variar.
            const initialDelay = 50; // ms
            console.debug(`Iniciando reprodução da fila de áudio da IA com delay de ${initialDelay}ms.`);
            setTimeout(playNextAudioChunk, initialDelay);
        }
    } catch (error) {
        console.error("Erro ao processar chunk de áudio recebido:", error);
        // Considerar limpar a fila ou sinalizar erro?
    }
}

/**
 * Handler para o evento 'audio_stream_end' do servidor.
 * Indica que não haverá mais chunks de áudio para a resposta atual da IA.
 */
function handleAudioStreamEnd() {
    console.log("Servidor sinalizou fim do stream de áudio da IA.");
    audioStreamEnded = true;

    // Se a fila de reprodução não estiver rodando mas ainda há chunks na fila de espera, inicia
    if (!isPlayingQueue && audioQueue.length > 0) {
        console.log("Fim do stream recebido, mas há chunks na fila. Iniciando reprodução final.");
        playNextAudioChunk();
    }
    // Se a fila de reprodução JÁ está rodando, ela continuará até esvaziar a audioQueue
    // e então chamará finishAudioPlayback ao detectar audioStreamEnded = true.
     else if (audioQueue.length === 0 && !isPlayingQueue) {
         // Caso raro: Fim do stream chega e não há nada na fila e nada tocando.
         console.log("Fim do stream recebido, sem chunks na fila e nada tocando. Finalizando imediatamente.");
         finishAudioPlayback();
     }
}

/**
 * Processa e reproduz o próximo chunk (ou grupo de chunks) da fila de áudio da IA.
 * Usa `decodeAudioData` para converter os bytes PCM em AudioBuffer e agenda a reprodução.
 */
async function playNextAudioChunk() {
     // Verifica se deve parar: não há mais chunks e o stream terminou
    if (audioQueue.length === 0 && audioStreamEnded) {
        console.debug("Fila de espera vazia e stream terminado. Finalizando reprodução.");
        // Se ainda houver buffers agendados, esperamos eles terminarem.
        // A flag isPlayingQueue será resetada no onended do último buffer.
        if (audioBufferQueue.length === 0) {
             finishAudioPlayback();
        }
        return;
    }
     // Verifica se deve parar: chamada foi encerrada
     if (!isCallActive) {
         console.log("Chamada inativa durante playNextAudioChunk. Parando reprodução.");
         resetAudioPlayback(); // Limpa tudo
         return;
     }

    // Marca que a fila está sendo processada
    isPlayingQueue = true;

    // Se a fila de espera estiver vazia, mas o stream ainda não terminou, espera mais chunks
    if (audioQueue.length === 0) {
        console.debug("Fila de espera vazia, aguardando mais chunks ou fim do stream...");
        isPlayingQueue = false; // Permite que handleAudioChunk reinicie a reprodução se chegar novo chunk
        return;
    }


    try {
        // --- Agrupamento de Chunks ---
        // Pega um ou mais chunks da fila para processar juntos. Ajuda na fluidez.
        let currentChunkBuffers = [];
        let totalLength = 0;
        const maxChunksToGroup = 3; // Processa até 3 chunks por vez
        const maxBufferDurationMs = 300; // Ou até acumular ~300ms de áudio
        let accumulatedDurationEstimate = 0;

        while (audioQueue.length > 0 && currentChunkBuffers.length < maxChunksToGroup && accumulatedDurationEstimate < maxBufferDurationMs) {
            const buffer = audioQueue.shift(); // Pega o próximo chunk (ArrayBuffer)
            currentChunkBuffers.push(buffer);
            totalLength += buffer.byteLength;
            // Estima duração: bytes / (bytes_por_amostra * taxa_amostragem) * 1000
            accumulatedDurationEstimate += (buffer.byteLength / (2 * EXPECTED_SAMPLE_RATE)) * 1000;
        }
        // console.debug(`Processando ${currentChunkBuffers.length} chunks agrupados (${totalLength} bytes).`);

        // --- Criação do Buffer Contíguo ---
        const concatenatedAudioData = new Uint8Array(totalLength);
        let offset = 0;
        currentChunkBuffers.forEach(buffer => {
            concatenatedAudioData.set(new Uint8Array(buffer), offset);
            offset += buffer.byteLength;
        });

        // --- Criação do Cabeçalho WAV ---
        // decodeAudioData precisa de um formato de arquivo reconhecível (WAV é simples)
        // Assumimos PCM16, 1 canal, taxa de amostragem EXPECTED_SAMPLE_RATE
        const wavHeader = createWavHeader(concatenatedAudioData.byteLength, EXPECTED_SAMPLE_RATE, 1, 16);
        const wavBuffer = new Uint8Array(wavHeader.byteLength + concatenatedAudioData.byteLength);
        wavBuffer.set(new Uint8Array(wavHeader), 0);
        wavBuffer.set(concatenatedAudioData, wavHeader.byteLength);

        // --- Decodificação e Agendamento ---
        // Usa Promise para lidar com decodeAudioData de forma assíncrona
        const audioBuffer = await audioContext.decodeAudioData(wavBuffer.buffer);

        // Cria a fonte de áudio para este buffer
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        // Calcula o tempo de início: ou imediatamente após o último, ou agora se for o primeiro
        const startTime = (nextPlayTime > audioContext.currentTime)
            ? nextPlayTime
            : audioContext.currentTime;

        // Armazena info para controle e limpeza
        const audioInfo = {
            source: source,
            startTime: startTime,
            duration: audioBuffer.duration
        };
        audioBufferQueue.push(audioInfo); // Adiciona à fila de buffers *sendo tocados*

        // Agenda o início da reprodução
        source.start(startTime);
        // console.debug(`Agendado chunk para tocar em ${startTime.toFixed(3)}s (duração: ${audioBuffer.duration.toFixed(3)}s)`);

        // Atualiza o próximo tempo de início agendado
        nextPlayTime = startTime + audioBuffer.duration;

        // --- Callback 'onended' ---
        // Chamado quando este buffer específico termina de tocar
        source.onended = () => {
            // console.debug("Chunk de áudio terminou de tocar.");
            // Remove este buffer da fila de buffers ativos
            const index = audioBufferQueue.findIndex(item => item.source === source);
            if (index !== -1) {
                audioBufferQueue.splice(index, 1);
            } else {
                 console.warn("BufferSource terminado não encontrado na fila ativa.");
            }

            // Se a fila de buffers ativos está vazia E
            // (a fila de espera está vazia E o stream terminou), então finaliza tudo.
            if (audioBufferQueue.length === 0 && audioQueue.length === 0 && audioStreamEnded) {
                 console.log("Último buffer terminou e stream finalizado. Finalizando reprodução.");
                 finishAudioPlayback();
            }
            // Se a fila de buffers ativos está vazia, mas ainda pode haver chunks chegando,
            // chama playNextAudioChunk novamente para verificar a fila de espera.
            else if (audioBufferQueue.length === 0) {
                 // Chama sem delay para verificar imediatamente a fila de espera
                 playNextAudioChunk();
            }
             // Se ainda há buffers ativos tocando, não faz nada, espera o próximo onended.
        };

        // Se ainda há chunks na fila de espera, chama playNextAudioChunk novamente
        // para agendar o próximo grupo sem esperar o atual terminar completamente.
        // Isso permite um encadeamento mais rápido.
        if (audioQueue.length > 0) {
             // Pequeno delay para não sobrecarregar o event loop
             setTimeout(playNextAudioChunk, 5);
        }


    } catch (error) {
        console.error("Erro durante decodificação ou reprodução de áudio:", error);
        // Tentar continuar com o próximo chunk se houver erro neste
        isPlayingQueue = false; // Reseta flag para permitir nova tentativa
        if (audioQueue.length > 0) {
             setTimeout(playNextAudioChunk, 50); // Tenta próximo após um delay maior
        } else if (audioStreamEnded) {
             finishAudioPlayback(); // Se era o último e deu erro, finaliza
        }
    }
}


/**
 * Chamado quando toda a fila de áudio da IA foi reproduzida e o stream terminou.
 * Reseta os estados relacionados à reprodução de áudio da IA.
 */
function finishAudioPlayback() {
    console.log("Finalizando completamente a reprodução de áudio da IA.");

    // Resetar estado de reprodução
    isPlayingQueue = false;
    audioStreamEnded = true; // Garante que esteja true
    nextPlayTime = 0;
    audioQueue = []; // Limpa fila de espera (já deve estar vazia)
    audioBufferQueue = []; // Limpa fila ativa (já deve estar vazia)
    consecutiveChunks = 0;
    lastChunkTime = 0;

    // Atualizar interface
    isAISpeaking = false;
    updateSpeakingIndicators();
    transcriptElement.classList.remove('ai-responding', 'response-starting'); // Remove classes de resposta
    hideThinkingIndicator(); // Garante que indicador de pensamento seja removido

    // Resetar visualizador da IA para estado de repouso
    const bars = aiVisualizer.querySelectorAll('.bar');
    bars.forEach(bar => {
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
    });
}

/**
 * Para e limpa completamente o estado de reprodução de áudio da IA.
 * Usado ao encerrar a chamada ou em caso de erro grave.
 */
function resetAudioPlayback() {
    console.log("Resetando estado de reprodução de áudio da IA...");

    // Parar todas as fontes de áudio que possam estar agendadas ou tocando
    audioBufferQueue.forEach(item => {
        try {
            item.source.stop(); // Para a reprodução imediatamente
            item.source.disconnect(); // Desconecta o nó
        } catch (e) {
            // Ignorar erros se o source já parou ou foi desconectado
            // console.debug("Erro ao parar/desconectar source de áudio no reset:", e);
        }
    });

    // Limpar todas as filas e resetar flags
    audioBufferQueue = [];
    audioQueue = [];
    isPlayingQueue = false;
    audioStreamEnded = true; // Assume que terminou ao resetar
    nextPlayTime = 0;
    consecutiveChunks = 0;
    lastChunkTime = 0;

    // Resetar estados visuais relacionados à IA
    isAISpeaking = false;
    updateSpeakingIndicators();
    transcriptElement.classList.remove('ai-responding', 'response-starting', 'processing');
    hideThinkingIndicator();

    // Resetar visualizador da IA
    const aiBars = aiVisualizer.querySelectorAll('.bar');
    aiBars.forEach(bar => {
        bar.style.height = `${MIN_BAR_HEIGHT}px`;
    });
    console.log("Estado de reprodução resetado.");
}


// --- Funções Auxiliares (WAV e Base64) ---

/**
 * Cria um cabeçalho WAV mínimo para dados PCM.
 * @param {number} dataLength - Comprimento dos dados de áudio em bytes.
 * @param {number} sampleRate - Taxa de amostragem (ex: 16000, 24000).
 * @param {number} [numChannels=1] - Número de canais.
 * @param {number} [bitsPerSample=16] - Bits por amostra.
 * @returns {ArrayBuffer} O cabeçalho WAV como ArrayBuffer.
 */
function createWavHeader(dataLength, sampleRate, numChannels = 1, bitsPerSample = 16) {
    const blockAlign = numChannels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const buffer = new ArrayBuffer(44); // Tamanho padrão do cabeçalho WAV
    const view = new DataView(buffer);

    // Bloco RIFF
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true); // Tamanho total do arquivo - 8 bytes
    writeString(view, 8, 'WAVE');

    // Bloco fmt
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Tamanho do bloco fmt (16 para PCM)
    view.setUint16(20, 1, true);  // Formato de áudio (1 para PCM)
    view.setUint16(22, numChannels, true); // Número de canais
    view.setUint32(24, sampleRate, true); // Taxa de amostragem
    view.setUint32(28, byteRate, true); // Taxa de bytes por segundo
    view.setUint16(32, blockAlign, true); // Alinhamento de bloco (bytes por amostra * canais)
    view.setUint16(34, bitsPerSample, true); // Bits por amostra

    // Bloco data
    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true); // Tamanho dos dados de áudio

    return buffer;
}

/**
 * Escreve uma string em um DataView em uma posição específica.
 * @param {DataView} view - O DataView para escrever.
 * @param {number} offset - A posição inicial para escrever.
 * @param {string} string - A string a ser escrita.
 */
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

/**
 * Converte um ArrayBuffer para uma string Base64.
 * @param {ArrayBuffer} buffer - O ArrayBuffer a ser convertido.
 * @returns {string} A string Base64 resultante.
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// --- Handlers de Eventos do Servidor (Atualização da Interface) ---

/**
 * Handler para 'speech_started' (VAD do servidor detectou início da fala do usuário).
 */
function handleSpeechStarted() {
    console.log("Servidor (VAD): Fala do usuário iniciada.");
    // Embora tenhamos a detecção visual local, podemos usar este evento
    // para uma indicação mais precisa se necessário, ou apenas logar.
    // A flag isUserVisuallySpeaking já controla o indicador visual principal.
    transcriptElement.classList.add('user-speaking'); // Adiciona estilo à transcrição
}

/**
 * Handler para 'speech_stopped' (VAD do servidor detectou fim da fala do usuário).
 */
function handleSpeechStopped() {
    console.log("Servidor (VAD): Fala do usuário terminada.");
    // Reseta o indicador visual local, pois o servidor confirmou o fim da fala.
    isUserVisuallySpeaking = false;
    updateSpeakingIndicators();
    animateUserVisualizer(new Uint8Array(BARS_COUNT).fill(0)); // Zera visualizador
    transcriptElement.classList.remove('user-speaking');

    // Adiciona "..." ao final da fala do usuário na transcrição para indicar que a IA vai processar/responder.
    // Evita adicionar se a IA já estiver falando ou se já terminar com "..."
    if (!isAISpeaking && !conversationHistory.endsWith("...") && conversationHistory.trim() !== "") {
         // Encontra a última linha e adiciona "..."
         const lines = conversationHistory.trim().split('\n');
         if (lines.length > 0) {
            const lastLine = lines[lines.length - 1];
            // Adiciona apenas se a última linha não for da IA
            if (!lastLine.startsWith("IA:")) {
                 conversationHistory = conversationHistory.trimEnd() + "...\n\n";
                 transcriptElement.textContent = conversationHistory;
                 transcriptElement.scrollTop = transcriptElement.scrollHeight; // Rola para o final
            }
         }
    }
}

/**
 * Handler para 'processing_started' (Servidor começou a processar a fala do usuário).
 */
function handleProcessingStarted() {
    console.log("Servidor: Iniciou processamento da solicitação.");
    transcriptElement.classList.add('processing'); // Adiciona estilo de processamento
    showThinkingIndicator(); // Mostra indicador "Processando..."
}

/**
 * Handler para 'response_starting' (Servidor começou a gerar/enviar a resposta da IA).
 */
function handleResponseStarting() {
    console.log("Servidor: Iniciou envio da resposta.");
    transcriptElement.classList.remove('processing'); // Remove estilo de processamento
    hideThinkingIndicator(); // Esconde indicador "Processando..."
    transcriptElement.classList.add('response-starting'); // Adiciona estilo de início de resposta
     // Define que a IA está falando (para indicador visual), caso ainda não esteja
     if (!isAISpeaking) {
        isAISpeaking = true;
        updateSpeakingIndicators();
     }
}

/**
 * Mostra um indicador visual de que a IA está "pensando" (processando).
 */
function showThinkingIndicator() {
    // Evita duplicados
    if (document.querySelector('.thinking-indicator')) return;

    const thinkingIndicator = document.createElement('div');
    thinkingIndicator.className = 'thinking-indicator';
    thinkingIndicator.innerHTML = 'Processando<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';

    // Adiciona após o elemento de transcrição
    transcriptElement.parentNode.insertBefore(thinkingIndicator, transcriptElement.nextSibling);
}

/**
 * Remove o indicador visual de "pensando".
 */
function hideThinkingIndicator() {
    const indicator = document.querySelector('.thinking-indicator');
    if (indicator) {
        indicator.parentNode.removeChild(indicator);
    }
}

/**
 * Handler para 'text_chunk' (Recebe um pedaço de texto da transcrição/resposta da IA).
 * Atualiza o histórico de conversa exibido.
 * @param {object} data - Objeto contendo o texto (`data.text`).
 */
function handleTextChunk(data) {
    if (!data || typeof data.text !== 'string') {
        console.warn("Recebido chunk de texto inválido:", data);
        return;
    }

    const textChunk = data.text;
    // console.debug("Recebido chunk de texto:", textChunk); // Log muito verboso

    // Lógica para formatar a transcrição:
    // Se a última entrada não for da IA, adiciona "IA: "
    const trimmedHistory = conversationHistory.trimEnd();
    if (!trimmedHistory.endsWith("IA:") && !trimmedHistory.endsWith("...")) {
         // Se a última linha foi do usuário (ou vazia), adiciona nova linha para IA
         if (trimmedHistory === "" || trimmedHistory.includes("\n\nVocê:")) {
             conversationHistory += "\n\nIA: ";
         } else {
             // Se a última linha foi da IA mas não terminou com ": ", adiciona nova linha
              conversationHistory += "\n\nIA: ";
         }
    }
     // Remove as reticências do usuário se existirem antes de adicionar texto da IA
     if (conversationHistory.endsWith("...\n\nIA: ")) {
         conversationHistory = conversationHistory.replace("...\n\nIA: ", "\n\nIA: ");
     } else if (conversationHistory.endsWith("...")) {
         // Caso raro: usuário parou, mas IA responde antes do speech_stopped chegar
         conversationHistory = conversationHistory.slice(0, -3) + "IA: ";
     }


    // Adiciona o chunk de texto ao histórico
    conversationHistory += textChunk;

    // Atualiza o elemento de transcrição na interface
    transcriptElement.textContent = conversationHistory;

    // Remove classes de estado anteriores e adiciona a de resposta ativa
    transcriptElement.classList.remove('response-starting', 'processing', 'user-speaking');
    transcriptElement.classList.add('ai-responding');

    // Manter o scroll sempre no final da transcrição
    transcriptElement.scrollTop = transcriptElement.scrollHeight;
}


/**
 * Handler para 'processing_error' (Erro ocorrido no servidor).
 * Exibe a mensagem de erro e reseta o estado da chamada.
 * @param {object} data - Objeto contendo a mensagem de erro (`data.error`).
 */
function handleError(data) {
    const errorMessage = (data && data.error) ? data.error : "Erro desconhecido do servidor";
    console.error("Erro recebido do servidor:", errorMessage);

    showSystemMessage(`Erro no servidor: ${errorMessage}`, 'error');

    // Considerar se deve encerrar a chamada ou apenas mostrar o erro
    // Para erros críticos, encerrar pode ser mais seguro.
    endCall(); // Encerra a chamada em caso de erro do servidor

    // Resetar estados visuais adicionais
    transcriptElement.classList.remove('user-speaking', 'processing', 'response-starting', 'ai-responding');
    hideThinkingIndicator();
}

// --- Gerenciamento da Conversa (Limpar, Salvar) ---

/**
 * Limpa o histórico de conversa na interface e na variável de estado.
 */
function clearConversation() {
    conversationHistory = "";
    transcriptElement.textContent = ""; // Limpa o conteúdo do elemento
    showSystemMessage("Histórico da conversa limpo.", "info");
    console.log("Histórico da conversa limpo.");
}

/**
 * Adiciona o botão "Limpar Conversa" à interface.
 */
function setupClearButton() {
     // Evita adicionar botão duplicado
    if (document.querySelector('.clear-button')) return;

    const clearButton = document.createElement('button');
    clearButton.className = 'action-button clear-button'; // Classe para estilização
    clearButton.innerHTML = '<i class="fas fa-trash"></i>'; // Ícone de lixeira
    clearButton.title = 'Limpar conversa';
    clearButton.onclick = clearConversation; // Define a função a ser chamada no clique

    // Adiciona o botão ao container da transcrição (ou outro local desejado)
    const transcriptContainer = document.querySelector('.transcript-container');
     if (transcriptContainer) {
        transcriptContainer.appendChild(clearButton);
        console.debug("Botão Limpar Conversa adicionado.");
    } else {
        console.error("Container da transcrição não encontrado para adicionar botão Limpar.");
    }
}

/**
 * Salva o histórico da conversa atual em um arquivo de texto.
 */
function saveConversation() {
    if (!conversationHistory.trim()) {
        showSystemMessage("A conversa está vazia, nada para salvar.", "info");
        return;
    }

    try {
        // Criar link de download temporário
        const element = document.createElement('a');
        // Define o conteúdo como URI de dados de texto plano
        element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(conversationHistory));

        // Nome do arquivo com data e hora
        const now = new Date();
        // Formata data e hora (padStart adiciona zero à esquerda se necessário)
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        const fileName = `conversa-ia-${dateStr}_${timeStr}.txt`;
        element.setAttribute('download', fileName); // Define o nome do arquivo para download

        // Oculta o elemento (não precisa ser visível)
        element.style.display = 'none';
        document.body.appendChild(element); // Adiciona ao DOM para poder ser clicado

        // Simula o clique no link para iniciar o download
        element.click();

        // Remove o elemento temporário do DOM
        document.body.removeChild(element);

        showSystemMessage("Conversa salva com sucesso!", "success");
        console.log(`Conversa salva como ${fileName}`);

    } catch (error) {
        console.error("Erro ao salvar conversa:", error);
        showSystemMessage("Ocorreu um erro ao tentar salvar a conversa.", "error");
    }
}

/**
 * Adiciona o botão "Salvar Conversa" à interface.
 */
function setupSaveButton() {
     // Evita adicionar botão duplicado
    if (document.querySelector('.save-button')) return;

    const saveButton = document.createElement('button');
    saveButton.className = 'action-button save-button'; // Classe para estilização
    saveButton.innerHTML = '<i class="fas fa-download"></i>'; // Ícone de download
    saveButton.title = 'Salvar conversa';
    saveButton.onclick = saveConversation; // Define a função a ser chamada no clique

    // Adiciona o botão ao container da transcrição
     const transcriptContainer = document.querySelector('.transcript-container');
     if (transcriptContainer) {
        transcriptContainer.appendChild(saveButton);
        console.debug("Botão Salvar Conversa adicionado.");
    } else {
        console.error("Container da transcrição não encontrado para adicionar botão Salvar.");
    }
}


// --- Inicialização da Aplicação ---
// Adiciona um listener para executar a inicialização quando o DOM estiver pronto.
window.addEventListener('load', initialize);