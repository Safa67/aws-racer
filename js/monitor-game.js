/**
 * monitor-game.js — Oyun Motoru
 *
 * Canvas çizimi, oyuncu hareketi, engel/güçlendirici spawn mantığı, çarpışma tespiti,
 * zorluk eğrisi, seri çarpanı, ramak kala, dalga olayları, dönüm noktaları ve canlı sıra.
 *
 * Bağımlılıklar: monitor-fx.js (fx, sfx). monitor-aws.js'deki liveRankFor() varsa canlı sıra çalışır.
 * Dışa aktarılan fonksiyonlar: startGame(), resetGame(), setTargetSpeed()
 * Dışa aktarılan değişkenler: isGameOver, gameStarted, score
 */

// --- Canvas kurulumu ---
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
canvas.height = window.innerHeight;

// ─── Zaman ve hız ────────────────────────────────────────────────────────────
// Kare hızından bağımsız hareket: tüm hızlar "60 fps'de kare başına piksel" olarak ayarlı.
// Her karede geçen süre bu referansa oranlanır (dt = 1 → 60 Hz'deki bir kare), böylece
// 30, 60, 144 veya 240 Hz ekranda oyun aynı hızda ve aynı hissiyatta çalışır.
const FRAME_MS     = 1000 / 60;
const MAX_FRAME_DT = 3;     // Sekme arka plandan dönünce/takılınca nesneler ışınlanmasın
const MAX_STEP_DT  = 1.5;   // Bir fizik adımının en büyük dt'si (hızlı nesneler engeli "atlamasın")
let lastFrameTime  = 0;

// Oyun hızı çarpanı. Resmi oyun hızı DEFAULT_TIME_SCALE (1.5): hızlar "60 fps'te kare başına piksel"
// olarak ayarlı, bu çarpan hepsini birlikte hızlandırır. Test butonları farklı hız seçtirir;
// resmi hızdan farklı modlarda skor tablosuna yazılmaz (skorlar karşılaştırılamaz).
// Seçim kaydedilmez: sayfa yenilenince her zaman resmi hızla başlar.
const DEFAULT_TIME_SCALE = 1.5;
let timeScale = DEFAULT_TIME_SCALE;

// ─── Ayarlanabilir oyun sabitleri ────────────────────────────────────────────
const BASIC_POINTS = 50;      // AWS logosunun EKRANDA görünen puanı (içte x10 tutulur)
const WARMUP_MS    = 4000;    // Oyun başında engelsiz, puansız ısınma süresi

// Zorluk: hız, oyun süresine (saniye) bağlı sürekli artar. Üst sınır yok: oyun kendiliğinden biter.
const RAMP_PER_SEC         = 0.022;  // Hız çarpanı artışı (saniye başına)
const NEAR_RATIO_START     = 0.30;   // Engellerin oyuncunun yakınında doğma oranı: başlangıç
const NEAR_RATIO_END       = 0.70;   //   ...ve bitiş
const NEAR_RATIO_RAMP_SEC  = 90;     //   ...kaç saniyede ulaşılır
const NOTHING_CHANCE       = 35;     // Ödül doğma anında "hiçbir şey çıkmama" yüzdesi (logo şansını yarıya indirir)

// Seri: arka arkaya yakalanan ödül sayısı. Çarpan basamakları ve hız etkisi:
const STREAK_TIERS         = [{ min: 10, mult: 3 }, { min: 6, mult: 2 }, { min: 3, mult: 1.5 }];
const STREAK_SPEED_PER     = 0.03;   // Seri başına oyun hızı artışı
const STREAK_SPEED_MAX     = 0.25;   // Seriyle gelen en yüksek hız artışı
const LAMBDA_SPEED         = 1.5;    // Lambda etkinken hız çarpanı

// Ramak kala
const NEAR_MISS_PX         = 22;     // Çarpışma sınırından bu kadar yakın geçiş = ramak kala
const NEAR_MISS_POINTS     = 10;
const NEAR_MISS_COOLDOWN   = 500;    // ms

// Dalga olayları (oyun saniyesi, ısınma sayılmaz)
const WAVE_FIRST_AT        = 20;
const WAVE_GAP_MIN         = 22;
const WAVE_GAP_MAX         = 32;
const LOGO_RAIN_AT         = 60;     // Logo Yağmuru: oyun boyunca yalnızca bir kez
const LATERAL_MAX_PX_SEC   = 9.85 * 60;   // Oyuncunun en yüksek yanal hızı (px/sn, hız çarpanı hariç)
const REACH_FACTOR         = 0.45;   // Geçilebilirlik hesabında oyuncunun yanal hızının güvenli kesri

// ─── Oyun durumu ─────────────────────────────────────────────────────────────
let isGameOver  = false;
let gameStarted = false;
let score       = 0;       // İç skor. Ekranda görünen = score / 10

// Çalışma durumu (her oyunda sıfırlanır)
let playSec        = 0;    // Isınma sonrası oyun süresi (gerçek saniye)
let warmupUntil    = 0;
let streak         = 0;
let bestStreak     = 0;
let streakBoost    = 0;    // Seriyle gelen hız artışının yumuşatılmış hali
let hasShield      = false;
let isInvincible   = false;   // Lambda etkinken true
let ec2Active      = false;
let lambdaTimer    = null;
let ec2Timer       = null;
let popups         = [];
let banners        = [];
let nextMilestoneAt = 500;
let lastNearMiss   = 0;
let lastRank       = null;
let wave           = null;
let nextWaveAt     = WAVE_FIRST_AT;
let nextWaveKind   = 'bsod';
let logoRainDone   = false;
let spawnPaused    = false;
let crash          = null;   // Çarpma sahnesi: oyun bitince canvas'ta oynar (çarpma efekti + mavi ekran)
let lastCountN     = null;   // Geri sayımda son gösterilen rakam (ses için)
let goPlayed       = false;
const CRASH_MS     = 1900;   // Çarpma sahnesinden sonra "Oyun bitti" kartının çıkma süresi

// --- Oyuncu ---
const player = {
    x:      canvas.width / 2,
    y:      canvas.height - 120,
    size:   60,
    speedX: 0,
};
let targetSpeedX = 0; // Lerp (yumuşak hareket) için hedef hız

/**
 * Pencere boyutu değişince (F11 tam ekran, pencere yeniden boyutlandırma) canvas yüksekliğini ve
 * oyuncunun alt kenara göre konumunu günceller. Önceden yükseklik yalnızca sayfa açılırken ayarlanıyordu.
 */
function resizeCanvas() {
    canvas.height = window.innerHeight;
    player.y      = canvas.height - 120;
}
window.addEventListener('resize', resizeCanvas);

// --- Engel görselleri ---
const bsodImg   = new Image(); bsodImg.src   = 'images/mavi-ekran-hatasi-bytekno-com-tr.webp';
const floppyImg = new Image(); floppyImg.src = 'images/realistic-illustration-floppy-disk-diskette-600w-2090370403.webp';
const serverImg = new Image(); serverImg.src = 'images/serverPhoto.png';
const cableImg  = new Image(); cableImg.src  = 'images/cables400.jpg';

const obstacleTypes = [
    { icon: '🗄️', img: serverImg },
    { icon: '💾', img: floppyImg },
    { icon: '🟦', img: bsodImg },
    { icon: '🔌', img: cableImg },
];
const SERVER_TYPE = obstacleTypes[0];
const BSOD_TYPE   = obstacleTypes[2];

// --- Güçlendirici görselleri ---
const awsImg    = new Image(); awsImg.src    = 'images/Amazon_Web_Services_Logo.svg.png';
const lambdaImg = new Image(); lambdaImg.src = 'images/lambda.svg';
const s3Img     = new Image(); s3Img.src     = 'images/s3.svg';
const ec2Img    = new Image(); ec2Img.src    = 'images/ec2.svg';

// chance: NOTHING_CHANCE ile birlikte toplam 100 (kalan pay "hiçbir şey çıkmaz")
const itemTypes = [
    { icon: '🔶', img: awsImg,    type: 'basic',  chance: 35 },
    { icon: '⚡',  img: lambdaImg, type: 'lambda', chance: 10 },
    { icon: '🪣',  img: s3Img,    type: 's3',     chance: 10 },
    { icon: '🖥️', img: ec2Img,   type: 'ec2',    chance: 10 },
];
const BASIC_TYPE = itemTypes[0];

// --- Aktif nesne listeleri ---
let enemies      = [];
let collectibles = [];

// ─── Hız ve çarpan hesapları ─────────────────────────────────────────────────

/** Oyun süresine bağlı sürekli (basamaksız) hız artışı. */
function rampMult()   { return 1 + RAMP_PER_SEC * playSec; }

/** Engellerin şu anki toplam hız çarpanı: süre x seri x Lambda. */
function speedNow()   { return rampMult() * (1 + streakBoost) * (isInvincible ? LAMBDA_SPEED : 1); }

/** Seri basamağından gelen puan çarpanı. */
function streakMult() {
    for (const t of STREAK_TIERS) if (streak >= t.min) return t.mult;
    return 1;
}

/** Toplam puan çarpanı: seri çarpanı + (EC2 etkinse +1). Çarpanlar toplanır, çarpılmaz. */
function scoreMult()  { return streakMult() + (ec2Active ? 1 : 0); }

/** Engellerin oyuncunun yakınında doğma oranı (30% → 70%). */
function nearRatio() {
    return NEAR_RATIO_START + (NEAR_RATIO_END - NEAR_RATIO_START) * Math.min(1, playSec / NEAR_RATIO_RAMP_SEC);
}

// ─── Spawn Fonksiyonları ──────────────────────────────────────────────────────

/** Bir engel nesnesi ekler (baseSpeed: 60 fps'te kare başına piksel, hız çarpanı hariç). */
function addEnemy(x, obsData, baseSpeed, isWave) {
    enemies.push({ x: x, y: -100, size: 50, baseSpeed: baseSpeed, obsData: obsData, passed: false, wave: !!isWave });
}

/**
 * Yeni bir engel oluşturur. Oyuncunun yakınında doğma oranı zamanla %30'dan %70'e çıkar.
 * Dalga olayı sırasında doğma durdurulur.
 */
function spawnEnemy() {
    if (!gameStarted || isGameOver) return;
    if (spawnPaused) { setTimeout(spawnEnemy, 150); return; }

    const selectedObs = obstacleTypes[Math.floor(Math.random() * obstacleTypes.length)];

    let spawnX;
    if (Math.random() < nearRatio()) {
        spawnX = player.x + (Math.random() * 300 - 150);
    } else {
        spawnX = Math.random() * canvas.width;
    }
    // Kenarlardan en az 25px içeride tut
    spawnX = Math.max(25, Math.min(canvas.width - 25, spawnX));

    addEnemy(spawnX, selectedObs, Math.random() * 2 + 2);

    setTimeout(spawnEnemy, Math.random() * 800 + 400);
}

/** Ağırlıklı seçim: bir güçlendirici türü ya da null (hiçbir şey çıkmaz). */
function pickCollectibleType() {
    let rand = Math.random() * 100;
    if (rand < NOTHING_CHANCE) return null;
    rand -= NOTHING_CHANCE;
    let cumulative = 0;
    for (let i = 0; i < itemTypes.length; i++) {
        cumulative += itemTypes[i].chance;
        if (rand < cumulative) return itemTypes[i];
    }
    return itemTypes[0];
}

function addCollectible(x, itemData, baseSpeed, extra) {
    collectibles.push(Object.assign({
        x: x, y: -100, size: 35, baseSpeed: baseSpeed, itemData: itemData,
        done: false, counts: Date.now() >= warmupUntil,
    }, extra || {}));
}

/** Yeni bir ödül oluşturur (bazen hiçbir şey çıkmaz). */
function spawnCollectible() {
    if (!gameStarted || isGameOver) return;

    const selected = pickCollectibleType();
    if (selected) {
        addCollectible(Math.random() * (canvas.width - 35 - 40) + 20, selected, Math.random() * 1.5 + 2);
    }

    setTimeout(spawnCollectible, Math.random() * 1500 + 1000);
}

// ─── Güçlendirici Uygulaması ─────────────────────────────────────────────────

/**
 * Yakalanan güçlendiricinin etkisini uygular ve ekranda gösterilecek etiketi döndürür.
 * @param {string} type - 'basic' | 'lambda' | 's3' | 'ec2'
 */
function applyPowerup(type) {
    // Isınma turunda güçlendiriciler alınır ama hiçbir etkisi olmaz (puan da yok)
    if (Date.now() < warmupUntil) return { text: 'Isınma: etkisiz', color: '#8A9099' };

    let label = null;

    if (type === 'basic') {
        const gained = BASIC_POINTS * scoreMult();
        score += gained * 10; // ekran skoru içteki skorun /10'udur
        label = { text: '+' + gained, color: '#FF9900' };

    } else if (type === 'lambda') {
        // Yenilmezlik + hız artışı (4 saniye). Hız çarpanı speedNow()'da hesaplanır;
        // art arda alınınca yalnızca süre yenilenir, hız asla kalıcı yükselmez.
        label = { text: '⚡ Yenilmez!', color: '#FF9900' };
        isInvincible = true;
        clearTimeout(lambdaTimer);
        lambdaTimer = setTimeout(() => { isInvincible = false; }, 4000);

    } else if (type === 's3') {
        // Bir çarpmayı engelleyen kalkan
        label = { text: '🪣 Kalkan!', color: '#0073BB' };
        hasShield = true;

    } else if (type === 'ec2') {
        // 5 saniye boyunca +1 puan çarpanı
        label = { text: '🖥️ x2 Puan!', color: '#1D8102' };
        ec2Active = true;
        clearTimeout(ec2Timer);
        ec2Timer = setTimeout(() => { ec2Active = false; }, 5000);
    }

    return label;
}

// ─── Seri, ramak kala, kutlamalar ────────────────────────────────────────────

function addBanner(text, sub, color, ms) {
    banners.push({ text: text, sub: sub, color: color, life: ms, max: ms });
    if (banners.length > 3) banners.shift();
}

/** Ekrandaki skor rakamını kısa süre büyütüp küçültür (puan alınca). */
function scorePop() {
    const el = document.getElementById('scoreVal');
    if (!el) return;
    el.classList.remove('pop');
    void el.offsetWidth;          // animasyonu yeniden başlat
    el.classList.add('pop');
}

function streakAdd() {
    const before = streakMult();
    streak++;
    if (streak > bestStreak) bestStreak = streak;
    if (streakMult() > before) {
        popups.push({ x: player.x, y: player.y - 95, text: 'SERİ x' + streakMult() + '!', color: '#8C4FFF', life: 80 });
        sfx.tier();
        fx.burst(player.x, player.y - 30, '#8C4FFF', 18, 4.5);
    }
}

function streakBreak() {
    if (streak >= 2) {
        popups.push({ x: player.x, y: player.y - 95, text: 'Seri bozuldu!', color: '#D13212', life: 70 });
        sfx.streakBreak();
    }
    streak = 0;
}

/** Dönüm noktası kutlaması: konfeti, yazı, ses. */
function celebrateMilestone(points) {
    addBanner('🎉 ' + points + ' PUAN!', 'Harika gidiyorsun', '#FF9900', 2200);
    fx.confetti(70, canvas.width);
    sfx.milestone();
}

/** Ekran puanı eşiği geçildiyse kutlar (puan birden çok eşiği atlarsa en yükseğini kutlar). */
function checkMilestone(screenPts) {
    if (screenPts < nextMilestoneAt) return;
    let reached = nextMilestoneAt;
    while (milestoneAfter(reached) <= screenPts) reached = milestoneAfter(reached);
    celebrateMilestone(reached);
    scorePop();
    nextMilestoneAt = milestoneAfter(reached);
}

function milestoneAfter(points) {
    const fixed = [500, 1000, 1500, 2000];
    for (const m of fixed) if (m > points) return m;
    return (Math.floor(points / 1000) + 1) * 1000;
}

/** Canlı sıra: günün tablosuna göre şu anki yeri; ilk 3'e girince geri bildirim verir. */
function updateRank(screenPts) {
    if (typeof liveRankFor !== 'function') return;
    const info = liveRankFor(screenPts);
    if (!info) return;

    const el = document.getElementById('rankVal');
    if (el) el.innerText = '#' + info.rank + ' / ' + info.total;

    if (lastRank !== null && info.rank < lastRank) {
        if (info.rank <= 3) {
            const medal = ['🏆', '🥈', '🥉'][info.rank - 1];
            const title = info.rank === 1 ? 'Günün 1.\'si oldun!' : 'Günün ' + info.rank + '.\'sü oldun!';
            addBanner(medal + ' ' + title, 'Sıralamada yükseldin', '#1D8102', 2600);
            fx.confetti(info.rank === 1 ? 90 : 50, canvas.width);
            sfx.top3();
        } else {
            popups.push({ x: canvas.width / 2, y: 150, text: '▲ Günün sırası: #' + info.rank, color: '#1D8102', life: 80 });
            sfx.rankUp();
        }
    }
    lastRank = info.rank;
}

// ─── Dalga Olayları ──────────────────────────────────────────────────────────
// Üç tür: Mavi Ekran Yağmuru, Sunucu Duvarı, Logo Yağmuru (60. saniyede yalnızca bir kez).
// Mavi Ekran ve Sunucu Duvarı HER ZAMAN geçilebilir üretilir:
//   - Olay başlamadan önce yeni engel doğması durur ve ekranın temizlenmesi beklenir.
//   - Yağmur: oyuncunun olay başındaki yerinden başlayan, adım başına sınırlı kayan bir "güvenli koridor"
//     belirlenir; engeller koridorun (komşu adımlarla birleşik) bandının dışına yerleştirilir.
//   - Duvar: boşluk, oyuncunun o anki hızıyla ulaşabileceği mesafenin içinde seçilir ve 3 kutu genişliğindedir.

const WAVE_INFO = {
    bsod: { text: '⚠ MAVİ EKRAN YAĞMURU!', sub: 'Güvenli yolu bul', color: '#0073BB', warnMs: 2500 },
    wall: { text: '⚠ SUNUCU DUVARI!',      sub: 'Boşluktan geç',    color: '#D13212', warnMs: 2500 },
    logo: { text: '💰 LOGO YAĞMURU!',      sub: 'Hepsini topla',    color: '#FF9900', warnMs: 1500 },
};

const RAIN_TICKS      = 11;     // Yağmurda adım sayısı
const RAIN_INTERVAL   = 380;    // ms
const RAIN_SPEED      = 3.2;    // baseSpeed
const RAIN_SHIFT_MAX  = 90;     // Koridorun adım başına en fazla kayması (px)
const RAIN_CLEAR      = 95;     // Koridorun her iki yanında engelsiz bırakılan yarı genişlik (px)
const OBST_MARGIN     = 25;
const WALL_TILE       = 65;     // Duvar kutusu aralığı (px)
const WALL_COUNT      = 2;      // Art arda duvar sayısı
const WALL_INTERVAL   = 1400;   // ms
const WALL_SPEED      = 3;
const LOGO_COUNT      = 14;
const LOGO_INTERVAL   = 280;    // ms

function scheduleNextWave() {
    const gap = WAVE_GAP_MIN + Math.random() * (WAVE_GAP_MAX - WAVE_GAP_MIN);
    nextWaveAt = playSec + gap;
    // Logo Yağmuru civarını boş bırak
    if (!logoRainDone && nextWaveAt > LOGO_RAIN_AT - 10 && nextWaveAt < LOGO_RAIN_AT + 10) {
        nextWaveAt = LOGO_RAIN_AT + 10;
    }
    nextWaveKind = (nextWaveKind === 'bsod') ? 'wall' : 'bsod';
}

function startWave(kind) {
    const info = WAVE_INFO[kind];
    wave = { kind: kind, phase: 'warn', t: 0, spawned: 0, walls: 0, spawnClock: 0 };
    spawnPaused = true;
    if (kind === 'logo') logoRainDone = true;
    addBanner(info.text, info.sub, info.color, info.warnMs + 600);
    sfx.warning();
}

/** Oyuncu satırına henüz ulaşmamış/geçmekte olan engel var mı? (Yeni dalga öncesi ekran temiz olmalı) */
function screenClear() {
    return !enemies.some(e => e.y < player.y + 70);
}

/** Oyuncunun o andaki hızıyla, bir engelin oyuncu satırına ulaşma süresinde (sn) yanal gidebileceği mesafe. */
function reachablePx(baseSpeed) {
    const v = baseSpeed * speedNow() * 60 * timeScale;           // engel hızı px/sn
    const travel = (player.y - 25 + 100) / v;                      // doğma → oyuncu satırı süresi (sn)
    return REACH_FACTOR * LATERAL_MAX_PX_SEC * timeScale * travel;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function startRainRun() {
    const maxShift = Math.min(RAIN_SHIFT_MAX, REACH_FACTOR * LATERAL_MAX_PX_SEC * timeScale * (RAIN_INTERVAL / 1000));
    const cs = [clamp(player.x, 110, canvas.width - 110)];
    for (let i = 1; i <= RAIN_TICKS + 1; i++) {
        cs.push(clamp(cs[i - 1] + (Math.random() * 2 - 1) * maxShift, 110, canvas.width - 110));
    }
    wave.corridor = cs;
    wave.phase    = 'run';
    wave.t        = 0;
    wave.spawnClock = RAIN_INTERVAL; // ilk adım hemen
    sfx.waveStart();
    fx.shake(6);
}

/** Yağmurun k. adımı: koridor bandının dışına en fazla iki Mavi Ekran bırakır. */
function spawnRainTick(k) {
    const cs = wave.corridor;
    const near = [cs[Math.max(0, k - 1)], cs[k], cs[k + 1]];
    const lo = Math.min.apply(null, near) - RAIN_CLEAR;
    const hi = Math.max.apply(null, near) + RAIN_CLEAR;

    const intervals = [];
    if (lo - OBST_MARGIN >= 40) intervals.push([OBST_MARGIN, lo]);
    if ((canvas.width - OBST_MARGIN) - hi >= 40) intervals.push([hi, canvas.width - OBST_MARGIN]);
    if (!intervals.length) return;

    const picked = [];
    for (let n = 0; n < 2; n++) {
        const total = intervals.reduce((s, iv) => s + (iv[1] - iv[0]), 0);
        let r = Math.random() * total, x = intervals[0][0];
        for (const iv of intervals) {
            if (r <= iv[1] - iv[0]) { x = iv[0] + r; break; }
            r -= iv[1] - iv[0];
        }
        if (picked.every(p => Math.abs(p - x) >= 70)) picked.push(x);
    }
    picked.forEach(x => addEnemy(x, BSOD_TYPE, RAIN_SPEED, true));
}

/** Boşluğu 3 kutu genişliğinde bırakan bir sunucu duvarı. gapCenter: boşluğun merkezi (px). */
function spawnWall(gapCenter) {
    for (let j = -12; j <= 12; j++) {
        if (Math.abs(j) <= 1) continue;               // 3 kutu boşluk
        const x = gapCenter + j * WALL_TILE;
        if (x < -WALL_TILE / 2 || x > canvas.width + WALL_TILE / 2) continue;
        addEnemy(x, SERVER_TYPE, WALL_SPEED, true);
    }
}

function nextWallGap() {
    // Boşluk, oyuncunun (ilk duvar) ya da önceki boşluğun (sonraki duvar) ulaşabileceği mesafede seçilir
    const origin = (wave.lastGap === undefined) ? player.x : wave.lastGap;
    const reach  = (wave.lastGap === undefined)
        ? reachablePx(WALL_SPEED)
        : REACH_FACTOR * LATERAL_MAX_PX_SEC * timeScale * (WALL_INTERVAL / 1000);
    const spread = Math.max(40, Math.min(reach - 20, 260));
    const gap = clamp(origin + (Math.random() * 2 - 1) * spread, 110, canvas.width - 110);
    wave.lastGap = gap;
    return gap;
}

function advanceWave(realMs) {
    const info = WAVE_INFO[wave.kind];
    wave.t += realMs;

    if (wave.phase === 'warn') {
        if (wave.t >= info.warnMs) {
            wave.t = 0;
            if (wave.kind === 'logo') { wave.phase = 'run'; wave.spawnClock = LOGO_INTERVAL; sfx.logoRain(); }
            else                      { wave.phase = 'wait'; }
        }

    } else if (wave.phase === 'wait') {
        // Ekran temizlenene kadar bekle (en fazla 3 sn)
        if (screenClear() || wave.t >= 3000) {
            wave.t = 0;
            if (wave.kind === 'bsod') startRainRun();
            else { wave.phase = 'run'; wave.spawnClock = WALL_INTERVAL; sfx.waveStart(); fx.shake(6); }
        }

    } else if (wave.phase === 'run') {
        wave.spawnClock += realMs;
        if (wave.kind === 'bsod') {
            while (wave.spawnClock >= RAIN_INTERVAL && wave.spawned < RAIN_TICKS) {
                wave.spawnClock -= RAIN_INTERVAL;
                spawnRainTick(wave.spawned++);
            }
            if (wave.spawned >= RAIN_TICKS) { wave.phase = 'tail'; wave.t = 0; }

        } else if (wave.kind === 'wall') {
            if (wave.spawnClock >= WALL_INTERVAL && wave.walls < WALL_COUNT) {
                wave.spawnClock -= WALL_INTERVAL;
                spawnWall(nextWallGap());
                wave.walls++;
            }
            if (wave.walls >= WALL_COUNT) { wave.phase = 'tail'; wave.t = 0; }

        } else { // logo yağmuru
            while (wave.spawnClock >= LOGO_INTERVAL && wave.spawned < LOGO_COUNT) {
                wave.spawnClock -= LOGO_INTERVAL;
                wave.spawned++;
                addCollectible(Math.random() * (canvas.width - 100) + 50, BASIC_TYPE, 3, { counts: false });
            }
            if (wave.spawned >= LOGO_COUNT) { wave.phase = 'tail'; wave.t = 0; }
        }

    } else if (wave.phase === 'tail') {
        // Engellerin geçmesi için kısa bekleme; sonra normal doğma devam eder
        if (wave.t >= (wave.kind === 'logo' ? 1200 : 1800)) {
            const kind = wave.kind;
            wave = null;
            spawnPaused = false;
            if (kind !== 'logo') scheduleNextWave();
            else nextWaveAt = Math.max(nextWaveAt, playSec + 8);
        }
    }
}

function runWaves(realMs) {
    if (wave) { advanceWave(realMs); return; }
    if (!logoRainDone && playSec >= LOGO_RAIN_AT) { startWave('logo'); return; }
    if (playSec >= nextWaveAt) startWave(nextWaveKind);
}

// ─── Arka Plan: paralaks, hız çizgileri, tehlike vinyeti ──────────────────────
// Üç katman: yavaş büyük bulutlar, orta hızda küçük "veri paketleri", hızlı çizgiler (yalnız hız artınca).
// Hepsi ekranın içinde döngüsel akar, hız çarpanıyla hızlanır. Kenarlarda hız arttıkça turuncudan kırmızıya
// dönen bir vinyet ve dalga olaylarında yavaş (saniyede ~1 kez) nabız atan kırmızı kenar vardır.
const bgItems = [];

function bgInit() {
    bgItems.length = 0;
    const W = canvas.width, H = canvas.height;
    for (let i = 0; i < 6; i++)  bgItems.push({ k: 'cloud',  x: Math.random() * W, y: Math.random() * H, s: 60 + Math.random() * 60, f: 0.25 });
    for (let i = 0; i < 22; i++) bgItems.push({ k: 'dot',    x: Math.random() * W, y: Math.random() * H, s: 1.5 + Math.random() * 2, f: 0.6 });
    for (let i = 0; i < 14; i++) bgItems.push({ k: 'streak', x: Math.random() * W, y: Math.random() * H, s: 0,                       f: 1.7 });
}

function bgUpdateDraw(dt, isDark) {
    if (!bgItems.length) bgInit();
    const m = speedNow();

    for (const b of bgItems) {
        b.y += 3 * b.f * m * dt;
        if (b.y > canvas.height + 120) { b.y = -80 - Math.random() * 100; b.x = Math.random() * canvas.width; }

        if (b.k === 'cloud') {
            ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(0, 115, 187, 0.055)';
            ctx.beginPath();
            ctx.ellipse(b.x, b.y, b.s, b.s * 0.45, 0, 0, Math.PI * 2);
            ctx.fill();
        } else if (b.k === 'dot') {
            ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(35, 47, 62, 0.16)';
            ctx.fillRect(b.x, b.y, b.s, b.s * 2.5);
        } else if (m > 1.25) {
            const a   = Math.min(0.35, (m - 1.25) * 0.2);
            const len = 20 + Math.min(90, (m - 1) * 35);
            ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, ' + a + ')' : 'rgba(35, 47, 62, ' + a + ')';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(b.x, b.y + len);
            ctx.stroke();
        }
    }

    // Tehlike vinyeti: hız arttıkça kenarlar turuncu → kırmızı
    const level = Math.max(0, Math.min(1, (m - 1.8) / 1.6));
    let   alpha = level > 0 ? 0.05 + 0.17 * level : 0;
    let   rgb   = m < 2.8 ? '255, 153, 0' : '209, 50, 18';
    // Dalga olayı boyunca yavaş nabız (saniyede ~1.1 kez; yanıp sönme sınırının çok altında)
    if (wave) {
        alpha = Math.max(alpha, 0.07) + 0.09 * (0.5 + 0.5 * Math.sin(performance.now() / 1000 * 2 * Math.PI * 1.1));
        rgb   = '209, 50, 18';
    }
    if (alpha > 0.01) {
        const W = canvas.width, H = canvas.height, edge = 80;
        let g = ctx.createLinearGradient(0, 0, edge, 0);
        g.addColorStop(0, 'rgba(' + rgb + ', ' + alpha + ')'); g.addColorStop(1, 'rgba(' + rgb + ', 0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, edge, H);
        g = ctx.createLinearGradient(W, 0, W - edge, 0);
        g.addColorStop(0, 'rgba(' + rgb + ', ' + alpha + ')'); g.addColorStop(1, 'rgba(' + rgb + ', 0)');
        ctx.fillStyle = g; ctx.fillRect(W - edge, 0, edge, H);
    }
}

// ─── Çizim Yardımcıları ───────────────────────────────────────────────────────

/**
 * Bir nesneyi canvas'a çizer. Görsel yüklenmediyse emoji fallback kullanır.
 * @param {object} obj    - Nesne ({x, y, size})
 * @param {object} data   - Görsel verisi ({img, icon, type})
 * @param {boolean} isEnemy - Engel mi, güçlendirici mi?
 */
function drawObject(obj, data, isEnemy) {
    if (data.img && data.img.complete && data.img.naturalWidth !== 0) {
        let w      = isEnemy ? obj.size + 15 : (data.type === 'basic' ? 60 : 40);
        let aspect = data.img.naturalHeight / data.img.naturalWidth;
        let h      = w * aspect;

        let isDark = document.body.classList.contains('dark-theme');

        // AWS logosunun arkasına daire (dark mod: beyaz, light mod: AWS turuncusu)
        if (!isEnemy && data.type === 'basic') {
            ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 153, 0, 0.3)';
            ctx.beginPath();
            ctx.arc(obj.x, obj.y - h / 2, w / 2 + 5, 0, 2 * Math.PI);
            ctx.fill();
            if (!isDark) {
                ctx.strokeStyle = '#FF9900';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        // Jpg ve WebP olan engeller için light modda beyaz arkaplanı multiply ile yok et
        if ((data.icon === '💾' || data.icon === '🔌' || data.icon === '🗄️') && !isDark) {
            ctx.globalCompositeOperation = 'multiply';
        }

        ctx.drawImage(data.img, obj.x - w / 2, obj.y - h, w, h);

        if ((data.icon === '💾' || data.icon === '🔌' || data.icon === '🗄️') && !isDark) {
            ctx.globalCompositeOperation = 'source-over';
        }
    } else {
        // Görsel yüklenemediyse emoji kullan
        ctx.font      = obj.size + 'px Arial';
        ctx.fillText(data.icon, obj.x, obj.y);
    }
}

// ─── Fizik Adımı ─────────────────────────────────────────────────────────────

/**
 * Dünyayı bir adım ilerletir.
 * @param {number} dt     - 60 fps karesi cinsinden adım süresi (oyun hızı çarpanı dahil)
 * @param {number} realMs - Bu adımın gerçek süresi (ms)
 */
function stepWorld(dt, realMs) {
    const warming = Date.now() < warmupUntil;

    // Geri sayım sesi (son 3 saniye) ve "BAŞLA!" sesi
    if (warming) {
        const n = Math.ceil((warmupUntil - Date.now()) / 1000);
        if (n <= 3 && n !== lastCountN) { lastCountN = n; sfx.tick(); }
    } else if (!goPlayed) {
        goPlayed = true;
        sfx.go();
    }

    if (!warming) {
        playSec += realMs / 1000;

        // Zaman tabanlı skor (ısınmada puan yok). Çarpan: seri + EC2.
        score += scoreMult() * dt;
        const screenPts = Math.floor(score / 10);
        document.getElementById('scoreVal').innerText = screenPts;
        checkMilestone(screenPts);
        updateRank(screenPts);

        runWaves(realMs);
    }

    // Seriyle gelen hız artışı yumuşakça değişir (seri bozulunca yavaşça normale döner)
    const boostTarget = Math.min(STREAK_SPEED_MAX, streak * STREAK_SPEED_PER);
    streakBoost += (boostTarget - streakBoost) * (1 - Math.exp(-dt * 0.02));

    // Lerp ile yumuşak hareket (0.25 değeri 60 fps'deki bir karenin oranıdır)
    player.speedX += (targetSpeedX - player.speedX) * (1 - Math.pow(0.75, dt));
    player.x      += player.speedX * dt;
    player.x       = Math.max(30, Math.min(canvas.width - 30, player.x));

    // --- Güçlendiriciler (ödül hızı, engel hızının yarısı kadar artar) ---
    const colSpeed = Math.sqrt(rampMult() * (1 + streakBoost));
    for (const col of collectibles) {
        col.y += col.baseSpeed * colSpeed * dt;

        if (!col.done) {
            const dx = Math.abs(player.x - col.x);
            const dy = Math.abs((player.y - 25) - (col.y - 20));
            if (dx < 55 && dy < 55) {
                col.done = true;
                collectItem(col, warming);
            } else if (col.y > canvas.height + 30) {
                // Yakalanmadan ekranın altından çıktı: seri bozulur (ısınmada ve yağmur logolarında bozmaz)
                col.done = true;
                if (col.counts && !warming) streakBreak();
            }
        }
    }
    collectibles = collectibles.filter(c => !c.done && c.y < canvas.height + 100);

    // --- Engeller ---
    const spd = speedNow();
    for (const e of enemies) {
        e.y += e.baseSpeed * spd * dt;

        const px = player.x, py = player.y - 25;
        const pw = 60, ph = 50;
        const ew = e.size + 15;
        let eh = ew;
        if (e.obsData.img && e.obsData.img.naturalWidth) {
            eh = ew * (e.obsData.img.naturalHeight / e.obsData.img.naturalWidth);
        }
        const ex = e.x, ey = e.y - (eh / 2);

        // Mesafe toleransı: (oyuncu yarı genişliği + engel yarı genişliği) * %85
        const limitX = ((pw / 2) + (ew / 2)) * 0.85;
        const limitY = ((ph / 2) + (eh / 2)) * 0.85;
        const dx = Math.abs(px - ex);

        if (dx < limitX && Math.abs(py - ey) < limitY) {
            if (hasShield) {
                // Kalkan ilk çarpmada gider (Lambda aktif olsa bile). Lambda koruyorsa seri bozulmaz.
                hasShield = false;
                fx.burst(e.x, e.y - 20, '#0073BB', 20, 5);
                fx.shake(9);
                sfx.shield();
                if (!isInvincible) streakBreak();     // Kalkan bir çarpmayı söndürür, seri bozulur
                e.y = canvas.height + 200;
            } else if (isInvincible) {
                fx.burst(e.x, e.y - 20, '#FF9900', 10, 4);
                e.y = canvas.height + 200;          // Yenilmezken engeli temizle
            } else {
                endGame();
                return;
            }
        } else if (!e.passed && ey >= py) {
            // Engelin merkezi oyuncunun merkezini geçti: ramak kala mı?
            e.passed = true;
            if (!warming && dx >= limitX && dx < limitX + NEAR_MISS_PX && Date.now() - lastNearMiss > NEAR_MISS_COOLDOWN) {
                lastNearMiss = Date.now();
                score += NEAR_MISS_POINTS * 10;
                popups.push({ x: player.x, y: player.y - 70, text: 'Ramak kala! +' + NEAR_MISS_POINTS, color: '#8C4FFF', life: 60 });
                scorePop();
                fx.shake(4);
                fx.burst(player.x + (e.x > player.x ? 30 : -30), player.y - 25, '#8C4FFF', 8, 3);
                sfx.nearMiss();
            }
        }
    }
    enemies = enemies.filter(e => e.y < canvas.height + 100);
}

/** Bir ödül yakalandı: etki, yüzen yazı, parçacık, ses ve seri. */
function collectItem(col, warming) {
    const type  = col.itemData.type;
    const label = applyPowerup(type);
    if (label) popups.push({ x: col.x, y: col.y - 40, text: label.text, color: label.color, life: 70 });
    if (warming) return;

    streakAdd();
    fx.burst(col.x, col.y - 20, label ? label.color : '#FF9900', 12, 3.5);
    if (type === 'basic')       { sfx.collect(streak); scorePop(); }
    else if (type === 'lambda') sfx.lambda();
    else if (type === 's3')     sfx.s3();
    else if (type === 'ec2')    sfx.ec2();
    else                        sfx.power();
}

// ─── Ana Oyun Döngüsü ─────────────────────────────────────────────────────────

function updateGame(now) {
    // dt: geçen süre / 60 fps karesi. İlk karede ve ölçülemeyen durumda 1.
    now = now || performance.now();
    const baseDt = lastFrameTime ? Math.max(0.2, Math.min((now - lastFrameTime) / FRAME_MS, MAX_FRAME_DT)) : 1;
    const dt     = baseDt * timeScale;
    lastFrameTime = now;

    const isDark = document.body.classList.contains('dark-theme');

    // Arka plan (sallanmaz)
    if (isDark) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillStyle = '#FAFAFA';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Oyun başlamadıysa veya bittiyse sadece boş canvas göster
    if (!gameStarted || isGameOver) {
        if (isGameOver && crash) {
            drawCrash(dt, baseDt * FRAME_MS, isDark);
        } else {
            // Oyuncu beklenirken (QR ekranı) arka planda yerel bir demo oynar: AWS çağrısı yok, ses yok
            if (!gameStarted && !isGameOver && typeof demoUpdate === 'function') demoUpdate(dt, baseDt * FRAME_MS, isDark);
            fx.update(dt);
        }
        requestAnimationFrame(updateGame);
        return;
    }

    // Fizik: dt büyükse küçük adımlara böl (hızlı nesneler çarpışmayı atlamasın)
    sfx.musicSetTempo(96 + 30 * (Math.min(speedNow(), 3.5) - 1));   // hız arttıkça müzik hızlanır
    const steps = Math.max(1, Math.ceil(dt / MAX_STEP_DT));
    for (let s = 0; s < steps && !isGameOver; s++) {
        stepWorld(dt / steps, (baseDt / steps) * FRAME_MS);
    }
    fx.update(dt);

    drawWorld(dt, baseDt * FRAME_MS, isDark);

    requestAnimationFrame(updateGame);
}

function drawWorld(dt, realMs, isDark) {
    // --- Dünya (ekran sallanmasıyla) ---
    const off = fx.shakeOffset(dt);
    ctx.save();
    ctx.translate(off.x, off.y);

    ctx.textAlign = 'center';
    bgUpdateDraw(dt, isDark);

    collectibles.forEach(col => drawObject(col, col.itemData, false));
    enemies.forEach(e => drawObject(e, e.obsData, true));

    // --- Oyuncu efektleri ---
    if (isInvincible) {
        ctx.beginPath();
        ctx.arc(player.x, player.y - 20, 50, 0, 2 * Math.PI);
        ctx.fillStyle = isDark ? 'rgba(255, 230, 0, 0.4)' : 'rgba(255, 153, 0, 0.4)';
        ctx.fill();
    }
    if (hasShield) {
        // Kalkan, Lambda aktifken de görünür (önceden Lambda halkası kalkanı gizliyordu)
        ctx.beginPath();
        ctx.arc(player.x, player.y - 20, isInvincible ? 56 : 50, 0, 2 * Math.PI);
        if (!isInvincible) {
            ctx.fillStyle = isDark ? 'rgba(0, 161, 201, 0.4)' : 'rgba(0, 115, 187, 0.15)';
            ctx.fill();
        }
        ctx.strokeStyle = isDark ? '#00A1C9' : '#0073BB';
        ctx.lineWidth   = 3;
        ctx.stroke();
    }

    // --- Oyuncu Rüzgar/Hız Efekti ---
    if (Math.abs(player.speedX) > 1.5) {
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(84, 91, 100, 0.5)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const dir = player.speedX > 0 ? -1 : 1;
        const mag = Math.abs(player.speedX);
        for (let w = 0; w < 4; w++) {
            const trailX = player.x + dir * (30 + Math.random() * 20);
            const trailY = player.y - 15 - Math.random() * 25;
            ctx.moveTo(trailX, trailY);
            ctx.lineTo(trailX + dir * (mag * 2.5 + 5), trailY);
        }
        ctx.stroke();
    }

    // --- Oyuncu (bulut ikonu) ---
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.speedX * 0.035);
    ctx.fillStyle = 'white';
    ctx.font      = player.size + 'px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('☁️', 0, 0);
    ctx.restore();

    fx.draw(ctx);

    // Yüzen yazılar ("+50", "Ramak kala!" ...): yukarı süzülüp kaybolur
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px Arial';
    popups.forEach(p => {
        p.life -= dt;
        p.y    -= 0.9 * dt;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 30));
        ctx.fillStyle   = p.color;
        ctx.fillText(p.text, p.x, p.y);
    });
    ctx.globalAlpha = 1;
    popups = popups.filter(p => p.life > 0);

    // EC2 aktifken x2 göstergesi
    if (ec2Active) {
        ctx.fillStyle = isDark ? '#00A1C9' : '#FF9900';
        ctx.font      = '20px Arial';
        ctx.fillText('+1 çarpan EC2!', player.x, player.y - 60);
    }

    ctx.restore();

    // --- HUD (sallanmaz) ---
    drawHud(realMs, isDark);
}

function drawHud(realMs, isDark) {
    ctx.textAlign = 'center';

    // Seri göstergesi
    if (streak >= 1) {
        const mult = scoreMult();
        ctx.font      = 'bold 30px Arial';
        ctx.fillStyle = '#8C4FFF';
        ctx.fillText('🔥 SERİ x' + streak, canvas.width / 2, 48);
        if (mult > 1) {
            ctx.font      = 'bold 20px Arial';
            ctx.fillStyle = isDark ? '#FFD700' : '#B7791F';
            ctx.fillText('puan x' + mult, canvas.width / 2, 74);
        }
    }

    // Geri sayım: ısınmanın son 3 saniyesi "3-2-1", bitince kısa "BAŞLA!"
    {
        const rem = warmupUntil - Date.now();
        let big = null, color = '#FF9900', size = 150, frac = 0;
        if (warmupUntil > 0 && rem > 0 && rem <= 3000) { big = String(Math.ceil(rem / 1000)); frac = (rem % 1000) / 1000; }
        else if (warmupUntil > 0 && rem <= 0 && -rem < 900) { big = 'BAŞLA!'; color = '#1D8102'; size = 100; frac = 1 - (-rem) / 900; }
        if (big) {
            ctx.save();
            ctx.globalAlpha = 0.35 + 0.65 * frac;
            ctx.font        = 'bold ' + Math.round(size * (1 + 0.35 * frac)) + 'px Arial';
            ctx.lineWidth   = 8;
            ctx.strokeStyle = isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.85)';
            ctx.strokeText(big, canvas.width / 2, canvas.height * 0.42);
            ctx.fillStyle   = color;
            ctx.fillText(big, canvas.width / 2, canvas.height * 0.42);
            ctx.restore();
        }
    }

    // Isınma ipucu (ilk saniyeler): telefonu eğerek bulutu hareket ettirmeyi öğret
    if (Date.now() < warmupUntil) {
        ctx.fillStyle = isDark ? '#FFFFFF' : '#232F3E';
        ctx.font = 'bold 26px Arial';
        ctx.fillText('ISINMA: Telefonu eğ, bulutu oynat!', canvas.width / 2, 120);
        ctx.font = '18px Arial';
        ctx.fillText('Engeller ' + Math.ceil((warmupUntil - Date.now()) / 1000) + ' sn sonra başlıyor', canvas.width / 2, 150);
        ctx.fillText('Bu sürede puan ve güçlendiriciler geçerli değil', canvas.width / 2, 176);
    }

    // Duyuru bantları (dalga uyarıları, kutlamalar): üstten alta dizilir
    banners.forEach((b, i) => {
        b.life -= realMs;
        const fadeIn  = Math.min(1, (b.max - b.life) / 200);
        const fadeOut = Math.min(1, b.life / 300);
        ctx.globalAlpha = Math.max(0, Math.min(fadeIn, fadeOut));
        const y = 215 + i * 78;
        ctx.fillStyle = b.color;
        ctx.font      = 'bold 34px Arial';
        ctx.fillText(b.text, canvas.width / 2, y);
        if (b.sub) {
            ctx.fillStyle = isDark ? '#DDDDDD' : '#545B64';
            ctx.font      = '18px Arial';
            ctx.fillText(b.sub, canvas.width / 2, y + 28);
        }
    });
    ctx.globalAlpha = 1;
    banners = banners.filter(b => b.life > 0);
}

// ─── Çarpma Sahnesi ──────────────────────────────────────────────────────────

/** Windows "mavi ekran" esprisi: çarpmadan sonra canvas'ı kaplar. */
function drawBsod(alpha, t) {
    const W = canvas.width, H = canvas.height;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = '#0078D7';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.font = 'bold 120px Arial';
    ctx.fillText(':(', 50, 190);
    ctx.font = 'bold 28px Arial';
    ctx.fillText('Bulutun çöktü.', 50, 250);
    ctx.font = '18px Arial';
    ctx.fillText('Eski bir donanıma takıldın ve bulutun yeniden', 50, 290);
    ctx.fillText('başlatılması gerekiyor. AWS ile ışık hızına çık!', 50, 316);
    const pct = Math.max(0, Math.min(100, Math.floor((t - 650) / 12)));
    ctx.font = 'bold 22px Arial';
    ctx.fillText('%' + pct + ' tamamlandı', 50, 380);
    ctx.font = '13px Arial';
    ctx.fillText('Hata kodu: LEGACY_HARDWARE_COLLISION', 50, 420);
    ctx.restore();
}

/**
 * Oyun biten karede başlayan çarpma sahnesini çizer: dünya donuk, bulut parçacıklara dağılır (ilk 0.7 sn
 * yavaş çekim), tek bir sönümlü kırmızı flaş, sonra mavi ekran. Işığa duyarlılık için yanıp sönme yoktur.
 */
function drawCrash(dt, realMs, isDark) {
    crash.t += realMs;
    const slow = crash.t < 700 ? 0.35 : 1;

    const off = fx.shakeOffset(dt * slow);
    ctx.save();
    ctx.translate(off.x, off.y);
    ctx.textAlign = 'center';
    bgUpdateDraw(dt * 0.15, isDark);
    collectibles.forEach(col => drawObject(col, col.itemData, false));
    enemies.forEach(e => drawObject(e, e.obsData, true));
    fx.update(dt * slow);
    fx.draw(ctx);
    ctx.restore();

    if (crash.t < 450) {
        ctx.fillStyle = 'rgba(209, 50, 18, ' + (0.45 * (1 - crash.t / 450)) + ')';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (crash.t > 650) {
        if (!crash.bsodSound) { crash.bsodSound = true; sfx.bsod(); }
        drawBsod(Math.min(1, (crash.t - 650) / 250), crash.t);
    }
}

// ─── Oyun Kontrolleri ─────────────────────────────────────────────────────────

/** Çalışma durumunu sıfırlar (yeni oyun için). */
function clearRunState() {
    score           = 0;
    playSec         = 0;
    warmupUntil     = 0;
    streak          = 0;
    bestStreak      = 0;
    streakBoost     = 0;
    hasShield       = false;
    isInvincible    = false;
    ec2Active       = false;
    enemies         = [];
    collectibles    = [];
    popups          = [];
    banners         = [];
    nextMilestoneAt = 500;
    lastNearMiss    = 0;
    lastRank        = null;
    wave            = null;
    nextWaveAt      = WAVE_FIRST_AT;
    nextWaveKind    = 'bsod';
    logoRainDone    = false;
    spawnPaused     = false;
    crash           = null;
    lastCountN      = null;
    goPlayed        = false;
    bgItems.length  = 0;
    clearTimeout(lambdaTimer);
    clearTimeout(ec2Timer);
    fx.clear();
    const rank = document.getElementById('rankVal');
    if (rank) rank.innerText = '-';
}

/**
 * Oyunu bitirir: oyun sonu ekranını gösterir ve skoru DynamoDB'ye kaydeder.
 * (DynamoDB kaydı monitor-aws.js tarafından dinlenen bir callback ile yapılır.)
 */
function endGame() {
    if (isGameOver) return; // aynı karede birden çok çarpışma skoru iki kez kaydetmesin
    isGameOver = true;
    if (typeof demoReset === 'function') demoReset();
    sfx.musicStop();
    sfx.crash();
    document.getElementById('finalScore').innerText    = Math.floor(score / 10);

    // Çarpma sahnesi: parçalanma, yavaş çekim, kırmızı flaş, mavi ekran. "Oyun bitti" kartı CRASH_MS sonra çıkar.
    // (Skor kaydı ve telefona bildirim beklemeden hemen yapılır; gecikme yalnızca görseldir.)
    const myCrash = { t: 0, bsodSound: false };
    crash = myCrash;
    fx.shake(22);
    fx.burst(player.x, player.y - 25, '#FFFFFF', 26, 6.5);
    fx.burst(player.x, player.y - 25, '#B39DDB', 18, 5);
    fx.burst(player.x, player.y - 25, '#D13212', 18, 7.5);
    setTimeout(() => {
        if (crash === myCrash && isGameOver) document.getElementById('gameOver').style.display = 'block';
    }, CRASH_MS);

    // DynamoDB kaydını aws modülüne devret
    if (typeof onGameOver === 'function') onGameOver(Math.floor(score / 10));
    // Kumandaya (telefona) oyunun bittiğini bildir
    if (typeof broadcastGameOver === 'function') broadcastGameOver();
}

/**
 * Oyunu sıfırlar ve yeni oyuncu bekleme ekranına döner.
 * Yeni bir oda ID'si oluşturulur (QR güncellenir).
 */
function resetGame() {
    isGameOver  = false;
    gameStarted = false;
    player.x    = canvas.width / 2;
    clearRunState();

    document.getElementById('gameOver').style.display = 'none';

    // Yeni oda oluştur (önceki oyuncu bağlanamaz)
    if (typeof onGameReset === 'function') onGameReset();
}

/**
 * Hedef hızı dışarıdan ayarlamak için (kumanda verisi gelince çağrılır).
 * @param {number} speed - Yeni hedef hız (tilt / 4)
 */
function setTargetSpeed(speed) {
    targetSpeedX = speed;
}

/**
 * Oyunu başlatır (ilk tilt verisi geldiğinde veya klavye ile).
 */
function startGame() {
    if (gameStarted || isGameOver) return;
    clearRunState();
    if (typeof demoReset === 'function') demoReset();   // bekleme demosunu temizle
    gameStarted = true;
    sfx.musicStart();
    document.getElementById('qrOverlay').style.display = 'none';
    warmupUntil = Date.now() + WARMUP_MS;
    // Isınma boyunca sadece güçlendiriciler gelir; engeller ısınma bitince başlar
    setTimeout(spawnEnemy, WARMUP_MS);
    spawnCollectible();
}

// --- Klavye desteği: yalnızca geliştirici modunda (Monitor.html?debug=1) ---
// Normal kullanımda klavye hiçbir şey yapmaz: oyunu yalnızca QR ile bağlanan telefon başlatır.
// Geliştirici modunda: Enter oyunu başlatır, ← → oyuncuyu hareket ettirir.
if (new URLSearchParams(window.location.search).has('debug')) {
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') startGame();
        if (e.key === 'ArrowLeft')  player.speedX = -8;
        if (e.key === 'ArrowRight') player.speedX =  8;
    });
    window.addEventListener('keyup', () => { player.speedX = 0; });
}

// Oyun döngüsünü başlat
updateGame();

// ─── Oyun Hızı Test Butonları ─────────────────────────────────────────────────

/** Oyun hızını ayarlar (1.5 = resmi hız, 1 = yavaş, 2.4 = eski kodun 144 Hz'deki hızı) ve butonları günceller. */
function setTimeScale(value) {
    timeScale = value;
    document.querySelectorAll('#speedBox button[data-scale]').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.scale) === value);
    });
}

document.querySelectorAll('#speedBox button[data-scale]').forEach(btn => {
    btn.addEventListener('click', () => {
        btn.blur(); // Boşluk/Enter tuşu butona basmasın
        setTimeScale(parseFloat(btn.dataset.scale));
    });
});
setTimeScale(timeScale);

// Hız test butonları yalnızca Monitor.html?test=1 ile görünür (etkinlikte ziyaretçiler görmesin)
if (new URLSearchParams(window.location.search).has('test')) {
    document.getElementById('speedGroup').style.display = 'contents';
}
