/**
 * monitor-demo.js — Bekleme ekranı demosu
 *
 * Oyuncu beklenirken QR kodun arkasında, bir bot bulutu oynayan küçük bir oyun gösterir.
 * Tamamen monitör bilgisayarının tarayıcısında çalışır: MQTT, DynamoDB ya da başka hiçbir
 * AWS çağrısı yapmaz, ses çıkarmaz, skor kaydetmez. Gerçek oyun başlayınca (startGame) ya da
 * bitince (endGame) sıfırlanır, gerçek oyunun durumuna dokunmaz.
 *
 * Bağımlılıklar (çalışma anında): monitor-game.js (canvas, ctx, drawObject, obstacleTypes, itemTypes,
 * timeScale, FRAME_MS) ve monitor-fx.js (fx). Fonksiyonlar bilerek `function` bildirimidir:
 * monitor-game.js bu dosyadan önce çalışsa bile `typeof demoUpdate` güvenle sorgulanır.
 */

const DEMO_ENABLED = true;

// Demo durumu (gerçek oyunun değişkenlerinden ayrı)
let demoEnemies = [];
let demoItems   = [];
let demoPopups  = [];
let demoX       = 0;
let demoVX      = 0;
let demoSec     = 0;
let demoSpawnE  = 0;   // sonraki engele kalan süre (ms)
let demoSpawnI  = 0;   // sonraki ödüle kalan süre (ms)
let demoCaught  = 0;

const DEMO_SPEED = 1.25;   // demoda sabit, ılımlı hız çarpanı

/** Demoyu sıfırlar (gerçek oyun başlarken/biterken çağrılır). */
function demoReset() {
    demoEnemies = [];
    demoItems   = [];
    demoPopups  = [];
    demoX       = 0;
    demoVX      = 0;
    demoSec     = 0;
    demoSpawnE  = 600;
    demoSpawnI  = 900;
    demoCaught  = 0;
}

/** Bir engelin şu anki yarı genişlik/yükseklik sınırlarını döndürür (oyundaki çarpışma hesabıyla aynı). */
function demoEnemyBox(e) {
    const ew = e.size + 15;
    let eh = ew;
    if (e.obsData.img && e.obsData.img.naturalWidth) eh = ew * (e.obsData.img.naturalHeight / e.obsData.img.naturalWidth);
    return { ew: ew, eh: eh, limitX: ((60 / 2) + (ew / 2)) * 0.85, limitY: ((50 / 2) + (eh / 2)) * 0.85 };
}

/** x konumu, yaklaşan engellerin çarpışma penceresinden uzak mı? */
function demoSafe(x, py, ts) {
    for (const e of demoEnemies) {
        const b  = demoEnemyBox(e);
        const ey = e.y - b.eh / 2;
        const v  = e.baseSpeed * DEMO_SPEED * 60 * ts;           // px/sn
        const t1 = (py - b.limitY - ey) / v;
        const t2 = (py + b.limitY - ey) / v;
        if (t2 < 0 || t1 > 1.5) continue;
        if (Math.abs(x - e.x) < b.limitX + 14) return false;
    }
    return true;
}

/**
 * Demo bir kare ilerletir ve çizer.
 * @param {number} dt     - 60 fps karesi cinsinden süre (oyun hızı çarpanı dahil)
 * @param {number} realMs - Gerçek süre (ms)
 * @param {boolean} isDark - Koyu tema mi
 */
function demoUpdate(dt, realMs, isDark) {
    if (!DEMO_ENABLED || document.hidden) return;

    const W  = canvas.width;
    const py = canvas.height - 120;
    const ts = timeScale;
    if (demoX === 0) { demoReset(); demoX = W / 2; }
    demoSec += realMs / 1000;

    // --- Doğma (gerçek zamanlı) ---
    demoSpawnE -= realMs;
    if (demoSpawnE <= 0) {
        demoSpawnE = 650 + Math.random() * 850;
        const near = Math.random() < 0.4;
        const x = near ? demoX + (Math.random() * 260 - 130) : Math.random() * W;
        demoEnemies.push({ x: Math.max(30, Math.min(W - 30, x)), y: -100, size: 50, baseSpeed: Math.random() * 1.6 + 2,
                           obsData: obstacleTypes[Math.floor(Math.random() * obstacleTypes.length)] });
    }
    demoSpawnI -= realMs;
    if (demoSpawnI <= 0) {
        demoSpawnI = 1100 + Math.random() * 1200;
        const type = Math.random() < 0.7 ? itemTypes[0] : itemTypes[1 + Math.floor(Math.random() * 3)];
        demoItems.push({ x: Math.random() * (W - 100) + 50, y: -100, size: 35, baseSpeed: Math.random() * 1.2 + 1.8, itemData: type });
    }

    // --- Bot: en yakın ödüle git, ama engellerden kaç ---
    let goalX = W / 2 + Math.sin(demoSec * 0.5) * 120;      // ödül yoksa hafifçe gezin
    let bestDy = 1e9;
    for (const it of demoItems) {
        const dy = py - it.y;
        if (dy > 20 && dy < 520 && dy < bestDy) { bestDy = dy; goalX = it.x; }
    }
    let target = null, bd = 1e9;
    for (let x = 35; x <= W - 35; x += 5) {
        if (!demoSafe(x, py - 25, ts)) continue;
        const d = Math.abs(x - goalX) + Math.abs(x - demoX) * 0.15;
        if (d < bd) { bd = d; target = x; }
    }
    if (target === null) target = demoX;
    const wantV = Math.max(-8, Math.min(8, (target - demoX) * 0.2));
    demoVX += (wantV - demoVX) * (1 - Math.pow(0.75, dt));
    demoX   = Math.max(30, Math.min(W - 30, demoX + demoVX * dt));

    // --- Ödüller ---
    for (const it of demoItems) it.y += it.baseSpeed * Math.sqrt(DEMO_SPEED) * dt;
    demoItems = demoItems.filter(it => {
        if (Math.abs(demoX - it.x) < 55 && Math.abs((py - 25) - (it.y - 20)) < 55) {
            demoCaught++;
            fx.burst(it.x, it.y - 20, '#FF9900', 10, 3);
            demoPopups.push({ x: it.x, y: it.y - 40, text: it.itemData.type === 'basic' ? '+50' : '✨', life: 60 });
            return false;
        }
        return it.y < canvas.height + 100;
    });

    // --- Engeller (bot çarparsa sessizce kaybolur, oyun bitmez) ---
    for (const e of demoEnemies) e.y += e.baseSpeed * DEMO_SPEED * dt;
    demoEnemies = demoEnemies.filter(e => {
        const b = demoEnemyBox(e);
        if (Math.abs(demoX - e.x) < b.limitX && Math.abs((py - 25) - (e.y - b.eh / 2)) < b.limitY) {
            fx.burst(e.x, e.y - 20, '#8A9099', 8, 3);
            return false;
        }
        return e.y < canvas.height + 100;
    });

    // --- Çizim (gerçek oyundaki görünüm, hafif soluk) ---
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'center';
    demoItems.forEach(it => drawObject(it, it.itemData, false));
    demoEnemies.forEach(e => drawObject(e, e.obsData, true));

    if (Math.abs(demoVX) > 1.5) {
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.5)' : 'rgba(84, 91, 100, 0.4)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const dir = demoVX > 0 ? -1 : 1;
        for (let w = 0; w < 3; w++) {
            const tx = demoX + dir * (30 + Math.random() * 20);
            const ty = py - 15 - Math.random() * 25;
            ctx.moveTo(tx, ty);
            ctx.lineTo(tx + dir * (Math.abs(demoVX) * 2.5 + 5), ty);
        }
        ctx.stroke();
    }
    ctx.save();
    ctx.translate(demoX, py);
    ctx.rotate(demoVX * 0.035);
    ctx.fillStyle = 'white';
    ctx.font = '60px Arial';
    ctx.fillText('☁️', 0, 0);
    ctx.restore();

    fx.draw(ctx);

    ctx.font = 'bold 24px Arial';
    demoPopups.forEach(p => {
        p.life -= dt;
        p.y    -= 0.9 * dt;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 30)) * 0.85;
        ctx.fillStyle = '#FF9900';
        ctx.fillText(p.text, p.x, p.y);
    });
    demoPopups = demoPopups.filter(p => p.life > 0);

    // Üst başlık: demo olduğunu ve davet (altta hız/ses butonları var, üstte boş)
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = isDark ? '#DDDDDD' : '#545B64';
    ctx.font = 'bold 18px Arial';
    ctx.fillText('▶ DEMO  ·  Sen de oyna: QR kodu okut!', W / 2, 34);
    ctx.restore();
}
