/**
 * monitor-game.js — Oyun Motoru
 *
 * Canvas çizimi, oyuncu hareketi, engel/güçlendirici
 * spawn mantığı ve çarpışma tespiti burada tutulur.
 *
 * Bağımlılıklar: Hiçbiri (bağımsız modül).
 * Dışa aktarılan fonksiyonlar: startGame(), resetGame(), setTargetSpeed()
 * Dışa aktarılan değişkenler: isGameOver, gameStarted, score
 */

// --- Canvas kurulumu ---
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');
canvas.height = window.innerHeight;

// --- Oyun durumu ---
let isGameOver      = false;
let gameStarted     = false;
let score           = 0;
let speedMultiplier = 1;

// --- Oyuncu ---
const player = {
    x:      canvas.width / 2,
    y:      canvas.height - 120,
    size:   60,
    speedX: 0,
};
let targetSpeedX = 0; // Lerp (yumuşak hareket) için hedef hız

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

// --- Güçlendirici görselleri ---
const awsImg    = new Image(); awsImg.src    = 'images/Amazon_Web_Services_Logo.svg.png';
const lambdaImg = new Image(); lambdaImg.src = 'images/lambda.svg';
const s3Img     = new Image(); s3Img.src     = 'images/s3.svg';
const ec2Img    = new Image(); ec2Img.src    = 'images/ec2.svg';

// chance: Toplam 100 olacak şekilde ağırlıklı şans yüzdesi
const itemTypes = [
    { icon: '🔶', img: awsImg,    type: 'basic',  chance: 70 },
    { icon: '⚡',  img: lambdaImg, type: 'lambda', chance: 10 },
    { icon: '🪣',  img: s3Img,    type: 's3',     chance: 10 },
    { icon: '🖥️', img: ec2Img,   type: 'ec2',    chance: 10 },
];

// --- Aktif nesne listeleri ---
let enemies      = [];
let collectibles = [];

// --- Aktif güçlendirici bayrakları ---
let hasShield      = false;
let isInvincible   = false;
let scoreMultiplier = 1;
let lambdaTimer    = null;
let ec2Timer       = null;

// ─── Spawn Fonksiyonları ──────────────────────────────────────────────────────

/**
 * Yeni bir engel oluşturur. Oyuncu kenardan beklemiyorsa dağılımı dengeler.
 * Engelcin %65'i oyuncunun yakınında, %35'i tamamen rastgele çıkar.
 */
function spawnEnemy() {
    if (!gameStarted || isGameOver) return;

    const size        = 50;
    const selectedObs = obstacleTypes[Math.floor(Math.random() * obstacleTypes.length)];

    // Oyuncunun yakınına odaklan (%65) veya tamamen rastgele (%35)
    let spawnX;
    if (Math.random() < 0.65) {
        spawnX = player.x + (Math.random() * 300 - 150);
    } else {
        spawnX = Math.random() * canvas.width;
    }
    // Kenarlardan en az 25px içeride tut
    spawnX = Math.max(25, Math.min(canvas.width - 25, spawnX));

    enemies.push({
        x:       spawnX,
        y:       -100,
        size:    size,
        speedY:  (Math.random() * 2 + 2) * speedMultiplier,
        obsData: selectedObs,
    });

    setTimeout(spawnEnemy, Math.random() * 800 + 400);
}

/**
 * Ağırlıklı rastgele seçimle yeni bir güçlendirici oluşturur.
 */
function spawnCollectible() {
    if (!gameStarted || isGameOver) return;

    const size = 35;
    let rand       = Math.random() * 100;
    let cumulative = 0;
    let selectedType = itemTypes[0];

    for (let i = 0; i < itemTypes.length; i++) {
        cumulative += itemTypes[i].chance;
        if (rand < cumulative) { selectedType = itemTypes[i]; break; }
    }

    collectibles.push({
        x:        Math.random() * (canvas.width - size - 40) + 20,
        y:        -100,
        size:     size,
        speedY:   (Math.random() * 1.5 + 2) * speedMultiplier,
        itemData: selectedType,
    });

    setTimeout(spawnCollectible, Math.random() * 1500 + 1000);
}

// ─── Güçlendirici Uygulaması ─────────────────────────────────────────────────

/**
 * Yakalanan güçlendiricinin etkisini uygular.
 * @param {string} type - 'basic' | 'lambda' | 's3' | 'ec2'
 */
function applyPowerup(type) {
    if (type === 'basic') {
        score += (50 * scoreMultiplier);

    } else if (type === 'lambda') {
        // Yenilmezlik + Hız artışı (4 saniye)
        isInvincible = true;
        let oldSpeed  = speedMultiplier;
        speedMultiplier += 1.5;
        clearTimeout(lambdaTimer);
        lambdaTimer = setTimeout(() => {
            isInvincible    = false;
            speedMultiplier = oldSpeed;
        }, 4000);

    } else if (type === 's3') {
        // Bir çarpmayı engelleyen kalkan
        hasShield = true;

    } else if (type === 'ec2') {
        // 5 saniye boyunca x2 puan
        scoreMultiplier = 2;
        clearTimeout(ec2Timer);
        ec2Timer = setTimeout(() => { scoreMultiplier = 1; }, 5000);
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

// ─── Ana Oyun Döngüsü ─────────────────────────────────────────────────────────

function updateGame() {
    let isDark = document.body.classList.contains('dark-theme');

    if (isDark) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillStyle = '#FAFAFA';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Oyun başlamadıysa veya bittiyse sadece boş canvas göster
    if (!gameStarted || isGameOver) {
        requestAnimationFrame(updateGame);
        return;
    }

    // Zaman tabanlı skor artışı
    score += Math.floor(1 * scoreMultiplier);
    document.getElementById('scoreVal').innerText = Math.floor(score / 10);

    // Her 500 puanda hızlanma (yenilmezlik sırasında hızlanma olmaz)
    if (score % 500 === 0 && !isInvincible) speedMultiplier += 0.15;

    // Lerp ile yumuşak hareket — 0.35 = duyarlı ama titremesiz
    player.speedX += (targetSpeedX - player.speedX) * 0.35;
    player.x      += player.speedX;
    player.x       = Math.max(30, Math.min(canvas.width - 30, player.x));

    // --- Güçlendiriciler ---
    ctx.textAlign = 'center';
    for (let i = 0; i < collectibles.length; i++) {
        let col = collectibles[i];
        col.y  += col.speedY;
        drawObject(col, col.itemData, false);

        // Çarpışma algılama (Ödüller için genişletildi - Box Collider)
        let px = player.x;
        let py = player.y - 25; // Bulutun görsel merkezi
        let cx = col.x;
        let cy = col.y - 20; // Objenin tahmini merkezi

        if (Math.abs(px - cx) < 55 && Math.abs(py - cy) < 55) {
            applyPowerup(col.itemData.type);
            col.y = canvas.height + 200; // Ekrandan çıkar
        }
    }
    collectibles = collectibles.filter(c => c.y < canvas.height + 100);

    // --- Engeller ---
    for (let i = 0; i < enemies.length; i++) {
        let e  = enemies[i];
        e.y   += e.speedY;
        drawObject(e, e.obsData, true);

        // Çarpışma algılama (Görsele göre birebir hitbox, %10 dış kısımdan tolerans)
        let px = player.x;
        let py = player.y - 25; // Oyuncu merkezi
        let pw = 60;
        let ph = 50;

        // Engelin güncel görsel boyutlarını ve merkezini bul
        let ew = e.size + 15;
        let eh = ew;
        if (e.obsData.img && e.obsData.img.naturalWidth) {
            eh = ew * (e.obsData.img.naturalHeight / e.obsData.img.naturalWidth);
        }
        let ex = e.x;
        let ey = e.y - (eh / 2);

        // Görselin %10'luk dış kısmı hasar vermeyecek şekilde mesafe hesaplanır
        // Mesafe toleransı: (Oyuncu Yarı Genişliği + Engel Yarı Genişliği) * %85-%90 arası bir tolerans çarpımı 
        let collisionX = Math.abs(px - ex) < ((pw / 2) + (ew / 2)) * 0.85;
        let collisionY = Math.abs(py - ey) < ((ph / 2) + (eh / 2)) * 0.85;

        if (collisionX && collisionY) {
            if (isInvincible) {
                e.y = canvas.height + 200;      // Yenilmezken engeli temizle
            } else if (hasShield) {
                hasShield = false;
                e.y       = canvas.height + 200; // Kalkan bir çarpmayı söndürür
            } else {
                endGame();
            }
        }
    }
    enemies = enemies.filter(e => e.y < canvas.height + 100);

    // --- Oyuncu efektleri ---
    if (isInvincible) {
        ctx.beginPath();
        ctx.arc(player.x, player.y - 20, 50, 0, 2 * Math.PI);
        ctx.fillStyle = isDark ? 'rgba(255, 230, 0, 0.4)' : 'rgba(255, 153, 0, 0.4)';
        ctx.fill();
    } else if (hasShield) {
        ctx.beginPath();
        ctx.arc(player.x, player.y - 20, 50, 0, 2 * Math.PI);
        ctx.fillStyle   = isDark ? 'rgba(0, 161, 201, 0.4)' : 'rgba(0, 115, 187, 0.15)';
        ctx.fill();
        ctx.strokeStyle = isDark ? '#00A1C9' : '#0073BB';
        ctx.lineWidth   = 3;
        ctx.stroke();
    }

    // --- Oyuncu Rüzgar/Hız Efekti ---
    if (Math.abs(player.speedX) > 1.5) {
        ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(84, 91, 100, 0.5)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        // Gittiği yönün tersine rüzgar çizgileri
        let dir = player.speedX > 0 ? -1 : 1; 
        let mag = Math.abs(player.speedX);
        for (let w = 0; w < 4; w++) {
            let trailX = player.x + dir * (30 + Math.random() * 20);
            let trailY = player.y - 15 - Math.random() * 25;
            ctx.moveTo(trailX, trailY);
            ctx.lineTo(trailX + dir * (mag * 2.5 + 5), trailY);
        }
        ctx.stroke();
    }

    // --- Oyuncu (bulut ikonu) ---
    ctx.save();
    ctx.translate(player.x, player.y);
    // Hıza oranlı hafif eğilme (max ~15-20 derece = ~0.3 radyan)
    ctx.rotate(player.speedX * 0.035);
    
    ctx.fillStyle = 'white';
    ctx.font      = player.size + 'px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('☁️', 0, 0);
    ctx.restore();

    // EC2 aktifken x2 göstergesi
    if (scoreMultiplier > 1) {
        ctx.fillStyle = isDark ? '#00A1C9' : '#FF9900';
        ctx.font      = '20px Arial';
        ctx.fillText('x2 EC2!', player.x, player.y - 60);
    }

    requestAnimationFrame(updateGame);
}

// ─── Oyun Kontrolleri ─────────────────────────────────────────────────────────

/**
 * Oyunu bitirir: oyun sonu ekranını gösterir ve skoru DynamoDB'ye kaydeder.
 * (DynamoDB kaydı monitor-aws.js tarafından dinlenen bir callback ile yapılır.)
 */
function endGame() {
    isGameOver = true;
    document.getElementById('gameOver').style.display  = 'block';
    document.getElementById('finalScore').innerText    = Math.floor(score / 10);

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
    isGameOver      = false;
    gameStarted     = false;
    score           = 0;
    speedMultiplier = 1;
    enemies         = [];
    collectibles    = [];
    player.x        = canvas.width / 2;
    hasShield       = false;
    isInvincible    = false;
    scoreMultiplier = 1;

    clearTimeout(lambdaTimer);
    clearTimeout(ec2Timer);

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
    gameStarted = true;
    document.getElementById('qrOverlay').style.display = 'none';
    spawnEnemy();
    spawnCollectible();
}

// --- Klavye desteği (test/demo amaçlı) ---
window.addEventListener('keydown', (e) => {
    startGame();
    if (e.key === 'ArrowLeft')  player.speedX = -8;
    if (e.key === 'ArrowRight') player.speedX =  8;
});
window.addEventListener('keyup', () => { player.speedX = 0; });

// Oyun döngüsünü başlat
updateGame();
