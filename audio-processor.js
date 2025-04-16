// audio-processor.js
// Processador de áudio moderno para o Assistente de Voz OpenAI Realtime

class AudioInputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer para processar áudio em blocos maiores (melhora eficiência)
    this.buffer = [];
    this.bufferSize = 4096; // Mesmo tamanho do ScriptProcessor original
  }

  process(inputs, outputs, parameters) {
    // Pegar primeiro canal do primeiro input
    const input = inputs[0][0];
    
    // Verificar se temos dados válidos
    if (input && input.length > 0) {
      // Adicionar o novo áudio ao buffer
      this.buffer = this.buffer.concat(Array.from(input));
      
      // Quando o buffer atingir o tamanho desejado, processar e enviar
      if (this.buffer.length >= this.bufferSize) {
        // Obter o buffer completo para processar
        const audioToProcess = this.buffer.slice(0, this.bufferSize);
        
        // Remover os dados processados do buffer
        this.buffer = this.buffer.slice(this.bufferSize);
        
        // Converter Float32Array para Int16Array (equivalente ao código original)
        const pcmBuffer = new Int16Array(this.bufferSize);
        for (let i = 0; i < this.bufferSize; i++) {
          const s = Math.max(-1, Math.min(1, audioToProcess[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Enviar dados para o thread principal
        this.port.postMessage({
          audioData: pcmBuffer.buffer
        }, [pcmBuffer.buffer]); // Transferir a propriedade para evitar cópia
      }
    }
    
    // Retornar true para manter o processamento ativo
    return true;
  }
}

// Registrar o processador com o nome que será referenciado no arquivo principal
registerProcessor('audio-input-processor', AudioInputProcessor);