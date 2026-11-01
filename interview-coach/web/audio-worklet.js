/**
 * 麦克风采集：任意采样率 -> 16k / int16 / 20ms 一包
 * 输出：{ pcm: ArrayBuffer, level: number }
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.buf = new Float32Array(0);
    this.readPos = 0;
    this.frame = new Int16Array(320);
    this.frameIdx = 0;
    this.muted = false;
    this.level = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'mute') {
        this.muted = !!event.data.value;
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const merged = new Float32Array(this.buf.length + channel.length);
    merged.set(this.buf);
    merged.set(channel, this.buf.length);
    this.buf = merged;

    while (this.readPos + 1 < this.buf.length) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const sample = this.buf[i] * (1 - frac) + this.buf[i + 1] * frac;

      this.level = this.level * 0.88 + Math.abs(sample) * 0.12;

      if (!this.muted) {
        const s = Math.max(-1, Math.min(1, sample));
        this.frame[this.frameIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.frameIdx === 320) {
          this.port.postMessage({ pcm: this.frame.buffer.slice(0), level: this.level });
          this.frame = new Int16Array(320);
          this.frameIdx = 0;
        }
      }

      this.readPos += this.ratio;
    }

    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.buf = this.buf.slice(consumed);
      this.readPos -= consumed;
    }
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
