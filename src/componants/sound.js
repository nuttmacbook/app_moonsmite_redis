import { read, write } from "../game/storage";

// Music and sound effects, all made live with the Web Audio API: no audio files to download,
// no extra packages. Phones only allow sound after the player touches the page, so nothing
// plays until the first tap; after that the music follows the screen (menu or minigame).
//
// The sound is a small fantasy orchestra built from scratch: string sections (many detuned
// voices spread across the stereo field), a choir (voices through vowel formants), brass that
// swells open, harp, timpani, taiko and cymbals, all in a long concert-hall reverb.
//
//   sound.music("menu") / sound.music("battle", difficulty)
//   sound.sfx.hammer(score), sfx.flameStart() / flameHeat(h) / flameStop(), sfx.rune...(), ...
//   sound.prefs() / sound.setPref("music" | "sfx", isOn)
//
// Storage: moonsmith:sound   { music: boolean, sfx: boolean }

const PREFS_KEY = "moonsmith:sound";
const MUSIC_LEVEL = 0.7;
const SFX_LEVEL = 0.9;

let prefs = { music: true, sfx: true, ...(read(PREFS_KEY, {}) ?? {}) };
let ctx = null;
let isUnlocked = false;
let nodes = null;             // master graph, built with the context
let wanted = { name: "menu", difficulty: "normal" };
let playing = null;           // { key, stop() }

/* ------------------------------------------------------------ graph */

const midi = (m) => 440 * 2 ** ((m - 69) / 12);

/** A concert hall: decaying noise, a little different in each ear so it sounds wide */
const makeImpulse = (seconds, decay) => {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * seconds);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
        const data = buffer.getChannelData(c);
        const preDelay = Math.floor(rate * (0.012 + c * 0.007));
        for (let i = preDelay; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
    return buffer;
};

const makeNoise = () => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
};

function build() {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx = new AudioCtx();

    const master = ctx.createGain();
    master.gain.value = 0.9;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(ctx.destination);

    // Hall: long and warm (the highs are rolled off so it does not hiss)
    const reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(3.8, 2.6);
    const warm = ctx.createBiquadFilter();
    warm.type = "lowpass";
    warm.frequency.value = 6000;
    const reverbIn = ctx.createGain();
    reverbIn.gain.value = 1;
    reverbIn.connect(reverb).connect(warm).connect(master);

    const music = ctx.createGain();
    music.gain.value = prefs.music ? MUSIC_LEVEL : 0;
    music.connect(master);
    const musicVerb = ctx.createGain();
    musicVerb.gain.value = 0.55;
    music.connect(musicVerb).connect(reverbIn);

    const sfx = ctx.createGain();
    sfx.gain.value = prefs.sfx ? SFX_LEVEL : 0;
    sfx.connect(master);
    const sfxVerb = ctx.createGain();
    sfxVerb.gain.value = 0.35;
    sfx.connect(sfxVerb).connect(reverbIn);

    nodes = { master, music, sfx, noise: makeNoise() };
    return true;
}

/**
 * First touch, click or key: create the audio context (browsers only allow it inside a
 * gesture). Safari counts click/touchend but not pointerdown, so every kind of gesture tries,
 * until the context is really running.
 */
function unlock() {
    if (!ctx && !build()) return;
    if (ctx.state !== "running" && document.visibilityState === "visible") {
        ctx.resume?.().catch?.(() => {});
        // Older iOS only opens the audio output after a sound starts inside the gesture
        const blip = ctx.createBufferSource();
        blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        blip.connect(ctx.destination);
        blip.start(0);
    }
    if (!isUnlocked) {
        isUnlocked = true;
        syncMusic();
    }
}

if (typeof window !== "undefined") {
    [ "pointerdown", "mousedown", "click", "touchend", "keydown" ].forEach((ev) => window.addEventListener(ev, unlock, { capture: true, passive: true }));
    // No sound from a tab in the background, and no battery spent on it
    document.addEventListener("visibilitychange", () => {
        if (!ctx) return;
        if (document.visibilityState === "hidden") ctx.suspend?.();
        else if (isUnlocked) ctx.resume?.();
    });
}

const ready = () => Boolean(ctx && isUnlocked && ctx.state !== "closed" && prefs.sfx);

/* ---------------------------------------------------------- building blocks */

/** Places a sound left or right; plain pass-through where the browser has no panner */
const panned = (to, pan) => {
    if (!pan || !ctx.createStereoPanner) return to;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(to);
    return p;
};

/** Attack, hold, release on a gain node; exponential so it sounds natural */
const envelope = (g, t, attack, hold, release, peak) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    if (hold > 0) g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return t + attack + hold + release;
};

/** One oscillator note with an attack/decay envelope (sfx and percussion) */
function tone({ to, freq, type = "sine", t = ctx.currentTime, attack = 0.005, dur = 0.3, peak = 0.2, detune = 0, glideTo, filter, q = 0.7, pan = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    osc.detune.value = detune;
    const g = ctx.createGain();
    const end = envelope(g, t, attack, 0, dur, peak);
    let head = osc;
    if (filter) {
        const f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = filter;
        f.Q.value = q;
        head = osc.connect(f);
    }
    head.connect(g).connect(panned(to, pan));
    osc.start(t);
    osc.stop(end + 0.05);
    return g;
}

/** A burst of filtered noise: hits, breath, cymbals, fire */
function noise({ to, t = ctx.currentTime, attack = 0.002, dur = 0.2, peak = 0.2, type = "bandpass", freq = 1000, q = 1, sweepTo, pan = 0 }) {
    const src = ctx.createBufferSource();
    src.buffer = nodes.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + attack + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    const end = envelope(g, t, attack, 0, dur, peak);
    src.connect(f).connect(g).connect(panned(to, pan));
    src.start(t, Math.random() * 1.5);
    src.stop(end + 0.05);
}

/** Metal struck: inharmonic partials ringing out, like an anvil or a bell */
function metal({ to, base, t = ctx.currentTime, dur = 1, peak = 0.12, partials = [ 1, 2.76, 5.4, 8.93 ], pan = 0 }) {
    partials.forEach((p, i) => tone({ to, freq: base * p, t, dur: dur / (1 + i * 0.6), peak: peak / (1 + i * 0.8), attack: 0.002, pan }));
}

/** FM bell: glassy and magical (celesta, glockenspiel, rune light) */
function bell({ to, freq, t = ctx.currentTime, dur = 1.6, peak = 0.08, ratio = 3.5, index = 2.5, pan = 0 }) {
    const carrier = ctx.createOscillator();
    carrier.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq * ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq * index, t);
    modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6);
    mod.connect(modGain).connect(carrier.frequency);
    const g = ctx.createGain();
    const end = envelope(g, t, 0.003, 0, dur, peak);
    carrier.connect(g).connect(panned(to, pan));
    carrier.start(t);
    mod.start(t);
    carrier.stop(end + 0.05);
    mod.stop(end + 0.05);
}

/**
 * A section of players on each note: several detuned saws spread across the stereo field,
 * with vibrato and a filter. Strings, low strings, brass and choir are all built on this.
 * @param {object} o
 * @param {number[]} o.notes       MIDI notes
 * @param {number} o.voices        players per note
 * @param {number} o.spread        detune spread in cents
 * @param {number} o.cutoff        filter frequency; with o.swell it opens from o.swellFrom (brass)
 * @param {number[]} [o.formants]  vowel formants (choir) instead of a lowpass
 */
function section({ to, notes, t, attack = 0.4, hold = 1, release = 1.2, peak = 0.02, voices = 3, spread = 14, cutoff = 2200, swell = false, swellFrom = 400, vibrato = 5, vibratoDepth = 9, formants, type = "sawtooth", width = 0.8 }) {
    const end = t + attack + hold + release;
    notes.forEach((n, ni) => {
        const freq = midi(n);
        const g = ctx.createGain();
        envelope(g, t, attack, hold, release, peak);

        // Vibrato: one slow wobble shared by the players on this note, fading in
        // (short notes skip it: fewer nodes on phones)
        let depth = null;
        if (vibratoDepth > 0) {
            const lfo = ctx.createOscillator();
            lfo.frequency.value = vibrato * (0.92 + Math.random() * 0.16);
            depth = ctx.createGain();
            depth.gain.setValueAtTime(0, t);
            depth.gain.linearRampToValueAtTime(vibratoDepth, t + Math.min(1.2, attack + 0.4));
            lfo.connect(depth);
            lfo.start(t);
            lfo.stop(end + 0.05);
        }

        // Tone shaping: a lowpass (that can swell open), or vowel formants for a choir
        let input;
        if (formants) {
            input = ctx.createGain();
            formants.forEach(([ f, q, level ]) => {
                const bp = ctx.createBiquadFilter();
                bp.type = "bandpass";
                bp.frequency.value = f;
                bp.Q.value = q;
                const lv = ctx.createGain();
                lv.gain.value = level;
                input.connect(bp).connect(lv).connect(g);
            });
        } else {
            const f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.Q.value = 0.8;
            if (swell) {
                f.frequency.setValueAtTime(swellFrom, t);
                f.frequency.exponentialRampToValueAtTime(cutoff, t + attack * 1.2 + 0.05);
                f.frequency.exponentialRampToValueAtTime(Math.max(swellFrom, cutoff * 0.5), end);
            } else {
                f.frequency.value = cutoff;
            }
            input = f;
            f.connect(g);
        }

        for (let v = 0; v < voices; v++) {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.value = freq;
            const at = voices === 1 ? 0 : v / (voices - 1) - 0.5;          // -0.5 … 0.5
            osc.detune.value = at * spread * 2 + (Math.random() - 0.5) * 3;
            depth?.connect(osc.detune);
            const pan = at * width * 2 * (ni % 2 ? -1 : 1);
            osc.connect(panned(input, pan));
            osc.start(t + Math.random() * 0.015);
            osc.stop(end + 0.05);
        }
        g.connect(to);
    });
    return end;
}

// Vowel formants for the choir: [frequency, Q, level]
const VOWEL_AH = [ [ 800, 6, 1 ], [ 1150, 7, 0.55 ], [ 2900, 9, 0.25 ] ];
const VOWEL_OH = [ [ 500, 6, 1 ], [ 800, 7, 0.5 ], [ 2700, 9, 0.18 ] ];

const strings = (to, notes, t, dur, peak = 0.012, attack = 0.6) => section({ to, notes, t, attack, hold: Math.max(0, dur - attack), release: 1.4, peak, voices: 3, spread: 12, cutoff: 2600 });
const lowStrings = (to, notes, t, dur, peak = 0.03) => section({ to, notes, t, attack: 0.02, hold: dur * 0.6, release: 0.12, peak, voices: 2, spread: 8, cutoff: 1300, vibratoDepth: 0, width: 0.3 });
const brass = (to, notes, t, dur, peak = 0.02) => section({ to, notes, t, attack: 0.12, hold: Math.max(0, dur - 0.12), release: 0.5, peak, voices: 3, spread: 7, cutoff: 3200, swell: true, swellFrom: 350, vibratoDepth: 5, width: 0.5 });
const choir = (to, notes, t, dur, peak = 0.05, vowel = VOWEL_AH) => section({ to, notes, t, attack: 1.0, hold: Math.max(0, dur - 1), release: 1.8, peak, voices: 4, spread: 16, formants: vowel, vibrato: 5.5, vibratoDepth: 14, width: 0.9 });

/** Harp: plucked, warm, rings out */
const harp = (to, n, t, peak = 0.05, pan = 0) => {
    tone({ to, freq: midi(n), type: "triangle", t, attack: 0.003, dur: 1.6, peak, filter: 3200, pan });
    tone({ to, freq: midi(n + 12), type: "sine", t, attack: 0.002, dur: 0.6, peak: peak * 0.35, pan });
};

/** Solo voice (flute / horn): soft attack, breath, vibrato that grows */
const solo = (to, n, t, dur, peak = 0.05) => {
    const freq = midi(n);
    const end = t + 0.08 + dur + 0.35;
    const g = ctx.createGain();
    envelope(g, t, 0.08, dur, 0.35, peak);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(12, t + Math.min(dur, 0.6));
    lfo.connect(depth);
    [ [ "sine", 1, 1 ], [ "triangle", 2, 0.22 ], [ "sine", 3, 0.08 ] ].forEach(([ type, mul, level ]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq * mul;
        depth.connect(osc.detune);
        const lv = ctx.createGain();
        lv.gain.value = level;
        osc.connect(lv).connect(g);
        osc.start(t);
        osc.stop(end);
    });
    lfo.start(t);
    lfo.stop(end);
    g.connect(panned(to, 0.15));
    noise({ to, t, attack: 0.03, dur: 0.12, peak: peak * 0.12, freq: freq * 2, q: 2 });     // breath
};

/** Timpani: tuned drum, long boom */
const timpani = (to, n, t, peak = 0.35) => {
    tone({ to, freq: midi(n) * 1.02, glideTo: midi(n), t, attack: 0.004, dur: 1.4, peak, filter: 900 });
    tone({ to, freq: midi(n) * 1.5, t, attack: 0.004, dur: 0.5, peak: peak * 0.3, filter: 900 });
    noise({ to, t, dur: 0.06, peak: peak * 0.35, type: "lowpass", freq: 600 });
};

/** Taiko: huge low drum */
const taiko = (to, t, peak = 0.45, pan = 0) => {
    tone({ to, freq: 95, glideTo: 46, t, attack: 0.003, dur: 0.55, peak, pan });
    tone({ to, freq: 180, glideTo: 90, t, attack: 0.002, dur: 0.12, peak: peak * 0.4, pan });
    noise({ to, t, dur: 0.08, peak: peak * 0.3, type: "lowpass", freq: 1200, pan });
};

/** Cymbal: crash, or a swell that grows into the next downbeat */
const cymbal = (to, t, { peak = 0.06, isSwell = false, dur = 1.6 } = {}) => noise({
    to, t, attack: isSwell ? dur : 0.003, dur: isSwell ? 0.08 : dur, peak, type: "highpass", freq: isSwell ? 4000 : 5500, q: 0.5, sweepTo: isSwell ? 8000 : 3500,
});

/* ----------------------------------------------------------- music */

/**
 * Calls onStep for every step, scheduled a little ahead of time so timers that fire late
 * never make the beat stumble.
 */
function sequencer(bpm, stepsPerBeat, onStep) {
    const stepDur = 60 / bpm / stepsPerBeat;
    let next = ctx.currentTime + 0.1;
    let step = 0;
    const timer = setInterval(() => {
        // Back from a suspended context: skip what was missed instead of playing it all at once
        if (next < ctx.currentTime - 0.2) next = ctx.currentTime + 0.05;
        while (next < ctx.currentTime + 0.2) {
            onStep(step, next, stepDur);
            next += stepDur;
            step++;
        }
    }, 25);
    return () => clearInterval(timer);
}

/** A track: its own fader on the music bus, faded in, faded out and torn down on stop */
function startTrack(key, build, level = 1) {
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, ctx.currentTime);
    out.gain.exponentialRampToValueAtTime(level, ctx.currentTime + 1.5);
    out.connect(nodes.music);
    const stopSequencer = build(out);
    return {
        key,
        stop: () => {
            const t = ctx.currentTime;
            out.gain.cancelScheduledValues(t);
            out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), t);
            out.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
            setTimeout(() => {
                stopSequencer();
                out.disconnect();
            }, 1300);
        },
    };
}

/** Rows of [MIDI note | null] per step; a note lasts until the next one */
const lengthAt = (line, i) => {
    let k = i + 1;
    while (k < line.length && line[k] === null) k++;
    return k - i;
};

/*
 * Menu — "The Moonlit Forge". D minor, 68 BPM, i – VI – III – VII.
 * Strings swell under a harp, a flute sings the theme, the choir joins the second time,
 * timpani mark each phrase, and an anvil rings somewhere far off.
 */
const MENU_CHORDS = [
    { notes: [ 50, 53, 57, 62 ], bass: 38, arp: [ 50, 57, 62, 65, 69, 74 ] },   // Dm
    { notes: [ 46, 50, 53, 58 ], bass: 34, arp: [ 46, 53, 58, 62, 65, 70 ] },   // Bb
    { notes: [ 48, 53, 57, 60 ], bass: 41, arp: [ 41, 48, 53, 57, 60, 65 ] },   // F
    { notes: [ 48, 52, 55, 60 ], bass: 36, arp: [ 48, 55, 60, 64, 67, 72 ] },   // C
];
const HARP_ORDER = [ 0, 1, 2, 3, 4, 5, 4, 3, 2, 3, 4, 5, 4, 3, 2, 1 ];
// The theme, in 8ths: 16 steps per chord
const MENU_THEME = [
    69, null, 74, null, 76, 77, 76, null, 74, null, null, null, 72, null, 69, null,
    70, null, 74, null, 77, null, 76, 74, 72, null, null, null, 74, null, null, null,
    72, null, 77, null, 81, null, 79, 77, 76, null, null, null, 77, null, 79, null,
    76, null, null, null, 74, null, 72, null, 74, null, null, null, null, null, null, null,
];

const menuTrack = (out) => sequencer(68, 2, (step, t, stepDur) => {
    const chordIndex = Math.floor(step / 16) % 4;
    const chord = MENU_CHORDS[chordIndex];
    const s = step % 16;
    const cycle = Math.floor(step / 64);

    if (s === 0) {
        strings(out, chord.notes, t, stepDur * 16, 0.011, 1.4);
        section({ to: out, notes: [ chord.bass ], t, attack: 0.8, hold: stepDur * 14, release: 1.5, peak: 0.05, voices: 3, spread: 6, cutoff: 700, vibratoDepth: 4, width: 0.2 });   // cellos and basses
        if (cycle >= 1 || chordIndex >= 2) choir(out, chord.notes.slice(1).map((n) => n + 12), t, stepDur * 16, 0.035, chordIndex % 2 ? VOWEL_OH : VOWEL_AH);
        timpani(out, chord.bass + 12, t, chordIndex === 0 ? 0.3 : 0.16);
        if (chordIndex === 0 && cycle >= 1) cymbal(out, t, { peak: 0.035, dur: 2.5 });
    }
    // Harp arpeggio, softer when the theme sings over it
    harp(out, chord.arp[HARP_ORDER[s]] + 12, t, cycle % 3 === 2 ? 0.045 : 0.03, s % 2 ? 0.35 : -0.35);

    // The theme, resting every third time round so it does not wear out
    if (cycle % 3 !== 2) {
        const n = MENU_THEME[step % 64];
        if (n) solo(out, n, t, stepDur * lengthAt(MENU_THEME, step % 64) * 0.92, 0.045);
    }
    // An anvil rings in the distance
    if (step % 64 === 44) metal({ to: out, base: midi(86), t, dur: 2.6, peak: 0.012, pan: -0.6 });
});

/*
 * Minigame — "Strike of the Moon Hammer". D minor, faster on harder levels.
 * Low strings drive 16ths, taiko and timpani pound, brass stabs, the choir holds the chords,
 * horns carry a heroic line, and cymbals swell into every fourth bar.
 */
const BATTLE_BPM = { easy: 112, normal: 124, hard: 136, insane: 150 };
const BATTLE_BARS = [
    { root: 38, chord: [ 50, 53, 57 ] },   // Dm
    { root: 34, chord: [ 46, 50, 53 ] },   // Bb
    { root: 41, chord: [ 48, 53, 57 ] },   // F
    { root: 36, chord: [ 48, 52, 55 ] },   // C
    { root: 38, chord: [ 50, 53, 57 ] },   // Dm
    { root: 34, chord: [ 46, 50, 53 ] },   // Bb
    { root: 36, chord: [ 48, 52, 55 ] },   // C
    { root: 33, chord: [ 45, 49, 52 ] },   // A (major: the turn back home)
];
const OSTINATO = [ 0, 0, 12, 0, 0, 0, 7, 0, 0, 0, 12, 0, 10, 0, 7, 0 ];
// Horn line, 16th steps over two bars, repeats every two bars
const HORN = [
    62, null, null, null, null, null, 69, null, 67, null, 65, null, 64, null, 65, null,
    67, null, null, null, 65, null, 64, null, 62, null, null, null, null, null, null, null,
];
const TAIKO_HITS = { 0: 0.5, 3: 0.25, 6: 0.32, 8: 0.45, 11: 0.25, 14: 0.3 };

const battleTrack = (difficulty) => (out) => sequencer(BATTLE_BPM[difficulty] ?? 124, 4, (step, t, stepDur) => {
    const barIndex = Math.floor(step / 16);
    const bar = BATTLE_BARS[barIndex % BATTLE_BARS.length];
    const s = step % 16;

    // Low strings, spiccato 16ths
    const n = bar.root + 12 + OSTINATO[s];
    lowStrings(out, [ n ], t, stepDur, s % 4 === 0 ? 0.035 : 0.024);

    // Drums
    if (s in TAIKO_HITS) taiko(out, t, TAIKO_HITS[s], s % 2 ? 0.25 : -0.15);
    if (s === 0) timpani(out, bar.root + 12, t, 0.3);
    if (s === 12 && barIndex % 2) timpani(out, bar.root + 19, t, 0.2);
    if (s === 4 || s === 12) noise({ to: out, t, dur: 0.1, peak: 0.07, freq: 2200, q: 1.2, pan: 0.3 });   // frame drum

    // Brass stabs and swells
    if (s === 0) brass(out, bar.chord.map((x) => x + 12), t, stepDur * 3, 0.016);
    if (s === 10) brass(out, bar.chord.map((x) => x + 12), t, stepDur * 1.5, 0.012);

    // Choir holds the harmony from the second bar
    if (s === 0 && barIndex >= 1) choir(out, bar.chord.map((x) => x + 12), t, stepDur * 15, 0.03, VOWEL_AH);

    // Strings high above, from the fifth bar
    if (s === 0 && barIndex >= 4) strings(out, [ bar.chord[1] + 24, bar.chord[2] + 24 ], t, stepDur * 15, 0.008, 0.3);

    // Heroic horn line from the third bar
    if (barIndex >= 2) {
        const i = step % 32;
        const h = HORN[i];
        if (h) brass(out, [ h + (barIndex % 4 >= 2 ? 12 : 0) ], t, stepDur * lengthAt(HORN, i) * 0.9, 0.03);
    }

    // Cymbal swell into every fourth bar, crash on it
    if (barIndex % 4 === 3 && s === 8) cymbal(out, t, { isSwell: true, dur: stepDur * 8, peak: 0.07 });
    if (barIndex % 4 === 0 && barIndex > 0 && s === 0) cymbal(out, t, { peak: 0.06, dur: 2 });
});

function syncMusic() {
    if (!ctx || !isUnlocked) return;
    const key = prefs.music ? `${wanted.name}:${wanted.difficulty}` : "";
    if (playing?.key === key) return;
    playing?.stop();
    playing = null;
    if (!key) return;
    playing = wanted.name === "battle" ? startTrack(key, battleTrack(wanted.difficulty), 1) : startTrack(key, menuTrack, 1.6);
}

/**
 * Which music should play now. Safe to call before the first tap: it starts then.
 * @param {"menu" | "battle"} name
 * @param {string} difficulty  easy | normal | hard | insane (battle tempo)
 */
function music(name, difficulty = "normal") {
    wanted = { name, difficulty: name === "battle" ? difficulty : "normal" };
    syncMusic();
}

/* ---------------------------------------------------------- effects */

const PENTA = [ 62, 65, 67, 69, 72 ];

const sfx = {
    /** Hammer on hot metal: a heavy blow, then the anvil rings, brighter the better the hit */
    hammer(score = 50) {
        if (!ready()) return;
        const to = nodes.sfx;
        const t = ctx.currentTime;
        const q = Math.max(0, Math.min(100, score)) / 100;
        const pan = (Math.random() - 0.5) * 0.4;
        tone({ to, freq: 120, glideTo: 48, t, dur: 0.22, peak: 0.55, pan });                        // weight of the blow
        noise({ to, t, dur: 0.06, peak: 0.3, freq: 2600, q: 0.7, pan });                             // impact
        metal({ to, base: (380 + q * 420) * (0.97 + Math.random() * 0.06), t, dur: 0.5 + q * 1.4, peak: 0.07 + q * 0.11, pan });
        if (score >= 95) {
            bell({ to, freq: midi(86), t: t + 0.03, dur: 1.6, peak: 0.05, ratio: 2, index: 1.2, pan: 0.3 });
            bell({ to, freq: midi(93), t: t + 0.09, dur: 1.4, peak: 0.035, ratio: 2, index: 1.2, pan: -0.3 });
        }
    },

    /** A ring that ran out with no tap: a dull swish */
    miss() {
        if (!ready()) return;
        noise({ to: nodes.sfx, attack: 0.04, dur: 0.3, peak: 0.12, type: "bandpass", freq: 600, q: 0.8, sweepTo: 180 });
    },

    /* Flame burn: one loop while the player holds */
    flame: null,

    flameStart() {
        if (!ready() || sfx.flame) return;
        const to = nodes.sfx;
        const t = ctx.currentTime;
        const src = ctx.createBufferSource();
        src.buffer = nodes.noise;
        src.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = "bandpass";
        band.frequency.value = 500;
        band.Q.value = 0.6;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.1);
        src.connect(band).connect(g).connect(to);
        src.start(t);
        // A deep roar under the hiss
        const roar = ctx.createBufferSource();
        roar.buffer = nodes.noise;
        roar.loop = true;
        const roarFilter = ctx.createBiquadFilter();
        roarFilter.type = "lowpass";
        roarFilter.frequency.value = 180;
        const roarGain = ctx.createGain();
        roarGain.gain.value = 0.9;
        roar.connect(roarFilter).connect(roarGain).connect(g);
        roar.start(t, 0.7);
        let heat = 0;
        // Crackles, more as the metal heats up
        const crackle = setInterval(() => {
            if (Math.random() < 0.25 + heat * 0.6) noise({ to, dur: 0.014, peak: 0.04 + Math.random() * 0.1, type: "highpass", freq: 2500 + Math.random() * 3000, pan: (Math.random() - 0.5) * 0.8 });
        }, 45);
        sfx.flame = {
            setHeat: (h) => {
                heat = Math.max(0, Math.min(1.3, h));
                const now = ctx.currentTime;
                band.frequency.setTargetAtTime(450 + heat * 1700, now, 0.05);
                roarFilter.frequency.setTargetAtTime(180 + heat * 220, now, 0.1);
            },
            stop: () => {
                clearInterval(crackle);
                const now = ctx.currentTime;
                g.gain.cancelScheduledValues(now);
                g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
                g.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
                src.stop(now + 0.2);
                roar.stop(now + 0.2);
            },
        };
    },

    /** @param {number} heat  0 cold … 1 black */
    flameHeat(heat) {
        sfx.flame?.setHeat(heat);
    },

    flameStop() {
        sfx.flame?.stop();
        sfx.flame = null;
    },

    /** Fire out: the metal hisses; a clean result rings like a bell */
    quench(score = 50) {
        if (!ready()) return;
        const to = nodes.sfx;
        noise({ to, dur: 0.7, peak: 0.12, type: "highpass", freq: 5000, sweepTo: 1600 });
        if (score >= 75) bell({ to, freq: midi(score >= 95 ? 86 : 81), t: ctx.currentTime + 0.04, dur: 1.4, peak: 0.06, ratio: 2, index: 1.5 });
    },

    /** Furnace lit: a whoomp of fire */
    ignite() {
        if (!ready()) return;
        const to = nodes.sfx;
        noise({ to, attack: 0.06, dur: 0.7, peak: 0.28, freq: 250, q: 0.6, sweepTo: 1500 });
        noise({ to, attack: 0.02, dur: 0.5, peak: 0.25, type: "lowpass", freq: 160 });
    },

    /* Rune memory */

    /** Rune i (0-11) lights up: a glass bell climbing the scale */
    runeReveal(i = 0) {
        if (!ready()) return;
        const n = PENTA[i % 5] + 12 * Math.floor(i / 5) + 12;
        bell({ to: nodes.sfx, freq: midi(n), dur: 1.1, peak: 0.07, ratio: 3.5, index: 1.8, pan: Math.sin((i / 12) * Math.PI * 2) * 0.6 });
    },

    /** All runes turn blue and catch fire: a magic swell with voices */
    runeArm() {
        if (!ready()) return;
        const to = nodes.sfx;
        const t = ctx.currentTime;
        noise({ to, attack: 0.25, dur: 0.6, peak: 0.1, freq: 400, q: 2, sweepTo: 3500 });
        choir(to, [ 62, 69, 74 ], t, 0.6, 0.05, VOWEL_OH);
    },

    /** Right rune: harp and a sparkle, climbing with every rune found */
    runeRight(found = 1) {
        if (!ready()) return;
        const n = PENTA[(found - 1) % 5] + 12 * (1 + Math.floor((found - 1) / 5)) + 12;
        const t = ctx.currentTime;
        harp(nodes.sfx, n, t, 0.09);
        bell({ to: nodes.sfx, freq: midi(n + 12), t: t + 0.02, dur: 0.9, peak: 0.04, ratio: 2, index: 1 });
    },

    /** Wrong rune: a dark low groan */
    runeWrong() {
        if (!ready()) return;
        const t = ctx.currentTime;
        section({ to: nodes.sfx, notes: [ 37, 38 ], t, attack: 0.02, hold: 0.15, release: 0.3, peak: 0.08, voices: 2, spread: 10, cutoff: 900, vibratoDepth: 0 });
        noise({ to: nodes.sfx, t, dur: 0.25, peak: 0.08, type: "lowpass", freq: 500 });
    },

    /** End of a round: a harp run up for a good score, a falling brass sigh for a bad one */
    grade(score = 50) {
        if (!ready()) return;
        const t = ctx.currentTime;
        if (score >= 70) {
            const run = score >= 95 ? [ 62, 65, 69, 74, 77, 81, 86 ] : [ 62, 65, 69, 74 ];
            run.forEach((n, k) => harp(nodes.sfx, n + 12, t + k * 0.05, 0.06, (k / run.length - 0.5) * 0.8));
        } else {
            brass(nodes.sfx, [ 57 ], t, 0.2, 0.03);
            brass(nodes.sfx, [ 53 ], t + 0.25, 0.4, 0.03);
        }
    },

    /* Countdown */

    /** Each beat: a war drum, softly */
    tick() {
        if (!ready()) return;
        taiko(nodes.sfx, ctx.currentTime, 0.28);
    },

    /** The level name: timpani and a low brass call */
    drum() {
        if (!ready()) return;
        const t = ctx.currentTime;
        timpani(nodes.sfx, 38, t, 0.45);
        brass(nodes.sfx, [ 50, 57 ], t, 0.5, 0.03);
    },

    /** START!: full orchestra hit — taiko, brass, choir and a crash */
    gong() {
        if (!ready()) return;
        const to = nodes.sfx;
        const t = ctx.currentTime;
        taiko(to, t, 0.6);
        timpani(to, 38, t, 0.4);
        brass(to, [ 50, 57, 62, 65 ], t, 0.35, 0.03);
        choir(to, [ 62, 69, 74 ], t, 0.5, 0.05);
        cymbal(to, t, { peak: 0.08, dur: 2.2 });
        metal({ to, base: 196, t, dur: 2.4, peak: 0.06, partials: [ 1, 1.48, 2.1, 2.9 ] });
    },

    /** Strike result: a brass fanfare sized to the score */
    result(score = 50) {
        if (!ready()) return;
        const to = nodes.sfx;
        const t = ctx.currentTime;
        if (score >= 75) {
            const line = score >= 95 ? [ [ 62, 0.15 ], [ 66, 0.15 ], [ 69, 0.15 ], [ 74, 1.2 ] ] : [ [ 62, 0.15 ], [ 69, 0.15 ], [ 74, 0.9 ] ];
            let at = t;
            line.forEach(([ n, d ]) => {
                brass(to, [ n, n + 12 ], at, d, 0.03);
                at += d;
            });
            timpani(to, 38, at - 0.02, 0.35);
            choir(to, [ 62, 66, 69, 74 ], at - 0.1, 1.2, score >= 95 ? 0.05 : 0.035);
            if (score >= 95) cymbal(to, at, { peak: 0.07, dur: 2.4 });
        } else if (score >= 40) {
            brass(to, [ 62, 69 ], t, 0.25, 0.028);
            brass(to, [ 65, 72 ], t + 0.28, 0.7, 0.028);
            timpani(to, 38, t + 0.28, 0.25);
        } else {
            brass(to, [ 57 ], t, 0.3, 0.03);
            brass(to, [ 53 ], t + 0.32, 0.9, 0.03);
            timpani(to, 33, t + 0.32, 0.25);
        }
    },
};

/* ----------------------------------------------------------- prefs */

const prefsOf = () => ({ ...prefs });

/**
 * @param {"music" | "sfx"} key
 * @param {boolean} isOn
 */
function setPref(key, isOn) {
    prefs = { ...prefs, [key]: Boolean(isOn) };
    write(PREFS_KEY, prefs);
    if (!nodes) return;
    const t = ctx.currentTime;
    const bus = key === "music" ? nodes.music : nodes.sfx;
    const level = key === "music" ? MUSIC_LEVEL : SFX_LEVEL;
    bus.gain.setTargetAtTime(isOn ? level : 0, t, 0.08);
    if (key === "sfx" && !isOn) sfx.flameStop();
    if (key === "music") syncMusic();
}

const sound = { music, sfx, prefs: prefsOf, setPref, unlock };

export { sound };
