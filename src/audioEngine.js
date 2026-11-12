// src/audioEngine.js
// Procedural WWI U-Boat Soundscape & Effects Synthesizer (Web Audio API)

const enginePitch = (throttle, submerged) => submerged ? 22 + throttle * 18 : 28 + throttle * 32;
const MASTER_VOLUME = 0.6;

export class UBoatAudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.dieselNodes = null;
    this.isSubmerged = false;
  }

  // Call this on the first user click/keypress to unlock browser/Electron audio
  init() {
    if (this.ctx) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContext();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = MASTER_VOLUME;
    this.masterGain.connect(this.ctx.destination);
  }

  setMuted(muted) {
    this.masterGain?.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.03);
  }

  shutdown() {
    const context = this.ctx;
    this.ctx = null;
    this.masterGain = null;
    this.dieselNodes = null;
    this.isSubmerged = false;
    if (context && context.state !== 'closed') return context.close();
    return Promise.resolve();
  }

  // 1. Continuous Surface Diesel Engine Rumble (with low-pass filter when submerged)
  startDieselEngine(throttleRatio = 0.5) {
    this.init();
    if (this.dieselNodes) return;

    const osc = this.ctx.createOscillator();
    const subOsc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    osc.type = 'sawtooth';
    subOsc.type = 'triangle';

    const baseFreq = enginePitch(throttleRatio, this.isSubmerged);
    osc.frequency.setValueAtTime(baseFreq, this.ctx.currentTime);
    subOsc.frequency.setValueAtTime(baseFreq * 0.5, this.ctx.currentTime);

    filter.type = 'lowpass';
    filter.frequency.value = this.isSubmerged ? 85 : 260;
    gain.gain.value = 0;

    osc.connect(filter);
    subOsc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    this.dieselNodes = { osc, subOsc, filter, gain };
    this.updateEngineState(throttleRatio, this.isSubmerged);
    osc.start();
    subOsc.start();
  }

  updateEngineState(throttleRatio, isSubmerged) {
    this.isSubmerged = isSubmerged;
    if (!this.dieselNodes || !this.ctx) return;

    const now = this.ctx.currentTime;
    const baseFreq = enginePitch(throttleRatio, isSubmerged);

    this.dieselNodes.osc.frequency.setTargetAtTime(baseFreq, now, 0.2);
    this.dieselNodes.subOsc.frequency.setTargetAtTime(baseFreq * 0.5, now, 0.2);
    this.dieselNodes.filter.frequency.setTargetAtTime(isSubmerged ? 85 : 260, now, 0.4);
    const volume = (isSubmerged ? 0.07 : 0.25) * (0.4 + 0.6 * throttleRatio);
    this.dieselNodes.gain.gain.setTargetAtTime(volume, now, 0.2);
  }

  stopDieselEngine() {
    if (!this.dieselNodes) return;
    const { osc, subOsc, filter, gain } = this.dieselNodes;
    const now = this.ctx.currentTime;
    this.dieselNodes = null;
    gain.gain.cancelAndHoldAtTime(now);
    gain.gain.setTargetAtTime(0, now, 0.04);
    osc.onended = () => {
      osc.disconnect();
      subOsc.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    osc.stop(now + 0.2);
    subOsc.stop(now + 0.2);
  }

  // 2. Hydrophone / Active Ping with Metallic Reverb Tail
  playSonarPing(pitchHz = 1320) {
    this.init();
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const delay = this.ctx.createDelay();
    const feedback = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitchHz, now);
    osc.frequency.exponentialRampToValueAtTime(pitchHz * 0.96, now + 1.4);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);

    delay.delayTime.value = 0.22;
    feedback.gain.value = 0.45;

    osc.connect(gain);
    gain.connect(this.masterGain);
    gain.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(this.masterGain);

    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      delay.disconnect();
      feedback.disconnect();
    };
    osc.start(now);
    osc.stop(now + 3.6);
  }

  // 3. Underwater Depth Charge Explosion (Filtered White Noise + Sub-Bass Concussion)
  playDepthCharge(distanceMeters = 200) {
    this.init();
    const now = this.ctx.currentTime;
    const intensity = Math.max(0.1, Math.min(1.0, 1 - distanceMeters / 1500));

    const bufferSize = this.ctx.sampleRate * 2.5;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = this.ctx.createBufferSource();
    whiteNoise.buffer = noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(420 * intensity + 120, now);
    filter.frequency.exponentialRampToValueAtTime(45, now + 2.2);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.8 * intensity, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 2.4);

    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(75, now);
    subOsc.frequency.exponentialRampToValueAtTime(22, now + 0.9);

    subGain.gain.setValueAtTime(0.9 * intensity, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);

    whiteNoise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    subOsc.connect(subGain);
    subGain.connect(this.masterGain);
    whiteNoise.onended = () => {
      whiteNoise.disconnect();
      filter.disconnect();
      noiseGain.disconnect();
      subOsc.disconnect();
      subGain.disconnect();
    };

    whiteNoise.start(now);
    subOsc.start(now);
    subOsc.stop(now + 1.1);
  }

  // 4. Pneumatic Torpedo Tube Launch Whoosh
  playTorpedoLaunch() {
    this.init();
    const now = this.ctx.currentTime;

    const bufferSize = this.ctx.sampleRate * 1.1;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const bandpass = this.ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(300, now);
    bandpass.frequency.exponentialRampToValueAtTime(950, now + 0.35);
    bandpass.frequency.exponentialRampToValueAtTime(180, now + 1.0);
    bandpass.Q.value = 1.8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.05);

    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(this.masterGain);
    noise.onended = () => {
      noise.disconnect();
      bandpass.disconnect();
      gain.disconnect();
    };

    noise.start(now);
  }

  playDeckGun() {
    this.init();
    const duration = 0.48;
    const { sampleRate } = this.ctx;
    const buffer = this.ctx.createBuffer(1, Math.ceil(sampleRate * duration), sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) {
      const time = index / sampleRate;
      const envelope = Math.exp(-time * 12);
      samples[index] = envelope * ((Math.random() * 2 - 1) * 0.62 + Math.sin(time * Math.PI * 2 * 72) * 0.38);
    }
    const source = this.ctx.createBufferSource();
    const filter = this.ctx.createBiquadFilter();
    const volume = this.ctx.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 1350;
    volume.gain.value = 0.45;
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(volume);
    volume.connect(this.masterGain);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      volume.disconnect();
    };
    source.start();
  }

  // 5. Deep-Water Hull Stress Creak & Rivet Pop
  // stressRatio: 0.0 (at test depth) to 1.0 (at crush depth)
  playHullCreak(stressRatio = 0.5) {
    this.init();
    const now = this.ctx.currentTime;
    const clampedStress = Math.max(0, Math.min(1, Number.isFinite(stressRatio) ? stressRatio : 0));
    const duration = 0.9 + Math.random() * 0.8;

    // Carrier oscillator produces the strained steel groan
    const carrier = this.ctx.createOscillator();
    carrier.type = 'sawtooth';
    const basePitch = 65 + Math.random() * 45 + clampedStress * 40;
    carrier.frequency.setValueAtTime(basePitch, now);
    // Slow, irregular pitch bend mimics bending metal plates
    carrier.frequency.linearRampToValueAtTime(basePitch * 0.82, now + duration * 0.5);
    carrier.frequency.linearRampToValueAtTime(basePitch * 1.08, now + duration);

    // Modulator adds metallic stick-slip friction vibration
    const modulator = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    modulator.type = 'triangle';
    modulator.frequency.setValueAtTime(14 + clampedStress * 18, now);
    modGain.gain.setValueAtTime(18 * clampedStress, now);

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);

    // Resonant bandpass gives it a hollow, enclosed submarine hull timbre
    const metalFilter = this.ctx.createBiquadFilter();
    metalFilter.type = 'bandpass';
    metalFilter.frequency.setValueAtTime(240 + clampedStress * 280, now);
    metalFilter.Q.value = 6.5;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.018 + 0.262 * clampedStress, now + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    carrier.connect(metalFilter);
    metalFilter.connect(gain);
    gain.connect(this.masterGain);
    carrier.onended = () => {
      carrier.disconnect();
      modulator.disconnect();
      modGain.disconnect();
      metalFilter.disconnect();
      gain.disconnect();
    };

    carrier.start(now);
    modulator.start(now);
    carrier.stop(now + duration + 0.05);
    modulator.stop(now + duration + 0.05);

    // At high stress (> 0.6), add a sharp metallic rivet pop near the end of the groan
    if (clampedStress > 0.6 && Math.random() < clampedStress) {
      const popTime = now + duration * (0.4 + Math.random() * 0.4);
      const popOsc = this.ctx.createOscillator();
      const popGain = this.ctx.createGain();

      popOsc.type = 'square';
      popOsc.frequency.setValueAtTime(950 + Math.random() * 400, popTime);
      popOsc.frequency.exponentialRampToValueAtTime(140, popTime + 0.06);

      popGain.gain.setValueAtTime(0.35 * clampedStress, popTime);
      popGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.07);

      popOsc.connect(popGain);
      popGain.connect(this.masterGain);
      popOsc.onended = () => {
        popOsc.disconnect();
        popGain.disconnect();
      };

      popOsc.start(popTime);
      popOsc.stop(popTime + 0.08);
    }
  }

  // 6. Emergency Main Ballast Tank Blow (High-Pressure Air + Water Churn)
  playBallastBlow() {
    this.init();
    const now = this.ctx.currentTime;
    const duration = 2.8;

    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Layer A: High-pressure compressed air valve hiss
    const airNoise = this.ctx.createBufferSource();
    airNoise.buffer = noiseBuffer;

    const airFilter = this.ctx.createBiquadFilter();
    airFilter.type = 'bandpass';
    airFilter.frequency.setValueAtTime(4000, now);
    airFilter.frequency.exponentialRampToValueAtTime(900, now + duration);
    airFilter.Q.value = 1.4;

    const airGain = this.ctx.createGain();
    airGain.gain.setValueAtTime(0.01, now);
    airGain.gain.linearRampToValueAtTime(0.45, now + 0.12);
    airGain.gain.setValueAtTime(0.4, now + 0.8);
    airGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    airNoise.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.masterGain);

    // An oscillating low-pass cutoff gives the ballast water its bubbling texture.
    const bubbleNoise = this.ctx.createBufferSource();
    bubbleNoise.buffer = noiseBuffer;
    const bubbleFilter = this.ctx.createBiquadFilter();
    bubbleFilter.type = 'lowpass';
    bubbleFilter.frequency.setValueAtTime(320, now);
    bubbleFilter.Q.value = 4.0;

    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(11, now);
    lfoGain.gain.setValueAtTime(140, now);
    lfo.connect(lfoGain);
    lfoGain.connect(bubbleFilter.frequency);

    const bubbleGain = this.ctx.createGain();
    bubbleGain.gain.setValueAtTime(0.01, now);
    bubbleGain.gain.linearRampToValueAtTime(0.55, now + 0.25);
    bubbleGain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    bubbleNoise.connect(bubbleFilter);
    bubbleFilter.connect(bubbleGain);
    bubbleGain.connect(this.masterGain);

    airNoise.onended = () => {
      airNoise.disconnect();
      airFilter.disconnect();
      airGain.disconnect();
    };
    bubbleNoise.onended = () => {
      bubbleNoise.disconnect();
      bubbleFilter.disconnect();
      bubbleGain.disconnect();
      lfo.disconnect();
      lfoGain.disconnect();
    };
    airNoise.start(now);
    bubbleNoise.start(now);
    lfo.start(now);
    lfo.stop(now + duration);
  }
}

export const audio = new UBoatAudioEngine();
