/**
 * monitor-fx.js — Görsel ve işitsel geri bildirim ("juice")
 *
 * Parçacıklar, ekran sallanması ve ses efektleri. Sesler WebAudio ile üretilir:
 * dosya yok, indirme yok, AWS maliyeti yok.
 *
 * Bağımlılıklar: Hiçbiri. monitor-game.js'den ÖNCE yüklenmelidir.
 * Dışa aktarılanlar: fx (parçacık/sallanma), sfx (ses efektleri)
 */

// ─── Parçacıklar ve Ekran Sallanması ─────────────────────────────────────────

const fx = (() => {
    const MAX_PARTICLES = 320;
    let particles  = [];
    let shakePower = 0;

    function add(p) {
        if (particles.length < MAX_PARTICLES) particles.push(p);
    }

    return {
        /** (x, y) noktasından renkli noktalar fırlatır. */
        burst(x, y, color, count = 14, speed = 4) {
            for (let i = 0; i < count; i++) {
                const a = Math.random() * Math.PI * 2;
                const s = speed * (0.4 + Math.random() * 0.8);
                add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1, g: 0.12,
                      life: 36 + Math.random() * 20, max: 56, size: 3 + Math.random() * 3, color, kind: 'dot', rot: 0, vr: 0 });
            }
        },

        /** Ekranın üstünden dökülen renkli konfeti. */
        confetti(count = 50, width = 600) {
            const colors = ['#FF9900', '#00A1C9', '#1D8102', '#D13212', '#FFD700', '#8C4FFF'];
            for (let i = 0; i < count; i++) {
                add({ x: Math.random() * width, y: -10 - Math.random() * 60,
                      vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, g: 0.06,
                      life: 120 + Math.random() * 50, max: 170, size: 6 + Math.random() * 5,
                      color: colors[Math.floor(Math.random() * colors.length)],
                      kind: 'rect', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 });
            }
        },

        /** Ekranı sallar (power: piksel). Süre içinde kendiliğinden azalır. */
        shake(power) {
            shakePower = Math.min(24, Math.max(shakePower, power));
        },

        /** Bu karedeki sallanma kayması; sallanmayı azaltır. */
        shakeOffset(dt) {
            if (shakePower < 0.4) { shakePower = 0; return { x: 0, y: 0 }; }
            const off = { x: (Math.random() - 0.5) * 2 * shakePower, y: (Math.random() - 0.5) * 2 * shakePower };
            shakePower *= Math.pow(0.88, dt);
            return off;
        },

        update(dt) {
            for (const p of particles) {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy += p.g * dt;
                p.rot += p.vr * dt;
                p.life -= dt;
            }
            particles = particles.filter(p => p.life > 0);
        },

        draw(ctx) {
            for (const p of particles) {
                ctx.globalAlpha = Math.max(0, Math.min(1, p.life / (p.max * 0.5)));
                ctx.fillStyle   = p.color;
                if (p.kind === 'rect') {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.rot);
                    ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
                    ctx.restore();
                } else {
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.globalAlpha = 1;
        },

        clear() {
            particles  = [];
            shakePower = 0;
        },
    };
})();

// ─── Ses Efektleri (WebAudio) ────────────────────────────────────────────────

const sfx = (() => {
    let actx    = null;   // AudioContext: tarayıcı kurallarına göre ilk kullanıcı etkileşiminde oluşturulur
    let master  = null;
    let soundOn = true;

    function running() {
        return soundOn && actx && actx.state === 'running';
    }

    /** Tek bir ton: freq → (varsa) slideTo, süre dur sn. */
    function tone(freq, dur, type = 'sine', vol = 0.5, slideTo = null, delay = 0) {
        if (!running()) return;
        const t0  = actx.currentTime + delay;
        const osc = actx.createOscillator();
        const g   = actx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    }

    /** Filtrelenmiş gürültü (vuruş, hışırtı, gürleme). */
    function noise(dur, vol = 0.4, filterFreq = 1000, filterType = 'bandpass', delay = 0) {
        if (!running()) return;
        const t0   = actx.currentTime + delay;
        const len  = Math.max(1, Math.floor(actx.sampleRate * dur));
        const buf  = actx.createBuffer(1, len, actx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = actx.createBufferSource();
        const flt = actx.createBiquadFilter();
        const g   = actx.createGain();
        src.buffer = buf;
        flt.type = filterType;
        flt.frequency.value = filterFreq;
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(flt).connect(g).connect(master);
        src.start(t0);
    }

    function arpeggio(freqs, step, type, vol) {
        freqs.forEach((f, i) => tone(f, step * 1.6, type, vol, null, i * step));
    }

    // ── Butonu güncelle ──
    function updateButton() {
        const btn = document.getElementById('soundBtn');
        if (!btn) return;
        if (!soundOn)                         btn.textContent = '🔇 Ses kapalı';
        else if (!actx || actx.state !== 'running') btn.textContent = '🔊 Ses (tıkla)';
        else                                   btn.textContent = '🔊 Ses açık';
        btn.classList.toggle('active', soundOn && actx && actx.state === 'running');
    }

    /** İlk kullanıcı etkileşiminde sesi açar (tarayıcılar kullanıcı etkileşimi olmadan ses çalmaz). */
    function unlock() {
        if (!actx) {
            try {
                actx   = new (window.AudioContext || window.webkitAudioContext)();
                master = actx.createGain();
                master.gain.value = 0.25;
                master.connect(actx.destination);
            } catch (e) { actx = null; }
        }
        if (actx && actx.state === 'suspended') actx.resume().then(updateButton).catch(() => {});
        updateButton();
    }

    ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlock));

    document.addEventListener('DOMContentLoaded', updateButton);
    window.addEventListener('load', () => {
        updateButton();
        const btn = document.getElementById('soundBtn');
        if (btn) btn.addEventListener('click', () => {
            soundOn = !soundOn;
            btn.blur();
            unlock();
            updateButton();
        });
    });

    return {
        unlock,
        isRunning: running,

        /** Ödül toplama: seri arttıkça nota yükselir (en fazla 1 oktav). */
        collect(streak = 0) {
            tone(520 * Math.pow(2, Math.min(streak, 12) / 12), 0.09, 'sine', 0.5, null);
            tone(780 * Math.pow(2, Math.min(streak, 12) / 12), 0.09, 'sine', 0.25, null, 0.05);
        },
        power()      { arpeggio([523, 659, 784, 1047], 0.05, 'triangle', 0.45); },
        shield()     { noise(0.28, 0.6, 350, 'lowpass'); tone(130, 0.25, 'sine', 0.6, 55); },
        nearMiss()   { noise(0.2, 0.35, 1600, 'bandpass'); tone(900, 0.1, 'sine', 0.18, 1500); },
        streakBreak(){ tone(330, 0.3, 'sawtooth', 0.22, 110); },
        tier()       { arpeggio([660, 880, 1100], 0.06, 'triangle', 0.4); },
        milestone()  { arpeggio([523, 659, 784, 1047, 1319], 0.09, 'triangle', 0.5); },
        rankUp()     { arpeggio([784, 1047], 0.08, 'sine', 0.4); },
        top3()       { arpeggio([523, 659, 784, 1047, 1319, 1568], 0.08, 'triangle', 0.55); },
        warning()    { [0, 0.22].forEach(d => tone(440, 0.16, 'square', 0.22, null, d)); },
        waveStart()  { noise(0.7, 0.55, 140, 'lowpass'); tone(90, 0.6, 'sawtooth', 0.25, 60); },
        logoRain()   { arpeggio([784, 988, 1175, 1568], 0.07, 'triangle', 0.45); },
        crash()      { noise(0.55, 0.8, 700, 'lowpass'); tone(220, 0.55, 'sawtooth', 0.45, 45); },
    };
})();
