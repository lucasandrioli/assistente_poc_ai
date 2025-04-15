    // pcm-processor.js (Debug Logs)

    const BUFFER_SIZE = 4096; 

    class PCMProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._buffer = new Int16Array(BUFFER_SIZE); 
        this._bufferIndex = 0; 
        this.totalSamplesProcessed = 0;
        // ***** DEBUG LOG *****
        console.log("[PCMProcessor] Instância criada."); 
      }

      process(inputs, outputs, parameters) {
        // ***** DEBUG LOG *****
        // Logar apenas uma vez a cada ~100 chamadas para não poluir muito
        if (this.totalSamplesProcessed % (128 * 100) < 128) { // 128 = tamanho típico do bloco de input
             console.log(`[PCMProcessor] process chamado. Samples processados: ${this.totalSamplesProcessed}`);
        }

        const inputChannel = inputs[0]?.[0]; 
        if (!inputChannel) {
          // ***** DEBUG LOG *****
          // console.log("[PCMProcessor] process chamado sem inputChannel.");
          return true; // Continua ativo
        }

        for (let i = 0; i < inputChannel.length; i++) {
          const int16Sample = Math.max(-1, Math.min(1, inputChannel[i])) * 0x7FFF;
          this._buffer[this._bufferIndex++] = int16Sample;

          if (this._bufferIndex >= BUFFER_SIZE) {
            // ***** DEBUG LOG *****
            console.log(`[PCMProcessor] Enviando buffer... Tamanho: ${this._buffer.byteLength} bytes`);
            try {
                this.port.postMessage({ 
                  pcmData: this._buffer.buffer.slice(0) 
                }); 
            } catch(e) {
                 console.error("[PCMProcessor] Erro ao fazer postMessage:", e);
            }
            this._bufferIndex = 0; 
          }
        }
        
        this.totalSamplesProcessed += inputChannel.length;
        return true; 
      }
    }

    try {
      registerProcessor('pcm-processor', PCMProcessor);
      console.log("[PCMProcessor] Processador registrado com sucesso.");
    } catch (e) {
      console.error("Falha ao registrar PCMProcessor:", e);
    }
  