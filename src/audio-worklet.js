const CHUNK_FRAMES = 8192;

class SubtitleCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_FRAMES);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;

    const frameCount = channels[0].length;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sample = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        sample += channels[channel][frame] ?? 0;
      }
      this.buffer[this.offset] = sample / channels.length;
      this.offset += 1;

      if (this.offset === this.buffer.length) {
        const ready = this.buffer;
        this.port.postMessage(ready, [ready.buffer]);
        this.buffer = new Float32Array(CHUNK_FRAMES);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("local-subtitles-capture", SubtitleCaptureProcessor);
