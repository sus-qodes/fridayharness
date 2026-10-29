/**
 * Tests only: a fake `AudioContext` that records the nodes it makes and the values scheduled on
 * their parameters.
 */
import type { AudioContextLike } from './synth.js';

export type ParamEvent = [kind: 'set' | 'exp' | 'lin', value: number, time: number];

export class FakeParam {
  value = 0;
  readonly events: ParamEvent[] = [];
  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push(['set', value, time]);
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push(['exp', value, time]);
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push(['lin', value, time]);
    return this;
  }
}

export class FakeNode {
  readonly outputs: FakeNode[] = [];
  connect(node: FakeNode) {
    this.outputs.push(node);
    return node;
  }
  disconnect() {}
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  starts: number[] = [];
  stops: number[] = [];
  start(t: number) {
    this.starts.push(t);
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

export class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  starts: number[] = [];
  start(t: number) {
    this.starts.push(t);
  }
  stop() {}
}

export class FakeAudioContext {
  currentTime = 2;
  state: AudioContextState = 'running';
  readonly sampleRate = 8_000;
  readonly destination = new FakeNode();
  readonly gains: FakeGain[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly filters: FakeFilter[] = [];
  readonly sources: FakeBufferSource[] = [];
  resumes = 0;
  suspends = 0;

  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createBiquadFilter() {
    const f = new FakeFilter();
    this.filters.push(f);
    return f;
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  createBufferSource() {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }

  /** The master gain is the first gain made, wired to the destination. */
  get master(): FakeGain | undefined {
    return this.gains[0];
  }

  /** Every frequency scheduled on the oscillators, in order. */
  frequencies(): number[] {
    return this.oscillators.flatMap((o) => o.frequency.events.map((e) => e[1]));
  }

  asContext(): AudioContextLike {
    return this as unknown as AudioContextLike;
  }
}
