/**
 * kumanda-ui.js — Kumanda Arayüzü ve Sensör Yönetimi
 *
 * Şunları yönetir:
 *   1. İsim doğrulama (uzunluk, küfür filtresi)
 *   2. Giriş → Oyun ekranı geçişi
 *   3. Gyroscope sensörü okuma ve tilt çubuğu güncelleme
 *   4. Oyun sırasında leaderboard periyodik yenileme
 *
 * Bağımlılıklar: kumanda-aws.js (dynamoClient, sendDataToAWS, fetchLeaderboard, iotData, ODA_ID)
 */

let PLAYER_NAME      = '';
let leaderInterval   = null; // Oyun içi leaderboard yenileme zamanlayıcısı
let smoothedGamma    = 0;    // Filtrelenmiş eğim verisi
const SENSOR_SMOOTH  = 0.25; // EMA katsayısı: 60 olay/sn'deki değer (0.1: çok yumuşak/yavaş, 0.8: sert/hızlı)
let lastSensorTime   = 0;    // Önceki sensör olayının zamanı (olay hızı cihaza göre 60–200 Hz değişir)

// Daha önce bu telefonda kullanılan isim kutuya otomatik gelir
try {
    const savedName = localStorage.getItem('awsracer_name');
    if (savedName) document.getElementById('playerNameInput').value = savedName;
} catch (e) {}

// ─── Bağlan Butonu ────────────────────────────────────────────────────────────

document.getElementById('connectBtn').addEventListener('click', () => {
    const inputName = document.getElementById('playerNameInput').value.trim();
    const nameError = document.getElementById('nameError');
    nameError.innerText = '';

    // Temel doğrulama
    if (!inputName)            { nameError.innerText = '⚠️ Lütfen bir isim girin!'; return; }
    if (inputName.length > 15) { nameError.innerText = '⚠️ İsim en fazla 15 karakter olabilir!'; return; }
    if (isProfane(inputName))  { nameError.style.color = '#D13212'; nameError.innerText = '❌ Bu isim uygun değil, lütfen başka bir isim yaz.'; return; }
    if (!dynamoClient)         { nameError.innerText = '⏳ AWS bağlantısı bekleniyor...'; return; }

    // İsim benzersiz olmak zorunda değil, oyun sınırı yok: yarışmacıları cihaz kodu (DeviceId) ayırt eder
    try { localStorage.setItem('awsracer_name', inputName); } catch (e) {}
    nameError.style.color = '#00FF00';
    nameError.innerText = '✅ Bağlanılıyor...';
    setTimeout(() => startPlaying(inputName), 400);
});

// ─── Oyun Bitti Ekranı ────────────────────────────────────────────────────────

let gameOverCheck = null; // Shadow yoklama zamanlayıcısı (MQTT sinyali gelmezse yedek)
let gameOverShown = false;

/** Oda başka bir telefona ait: kontrolü bırak ve bilgi ekranı göster. */
function showBusy() {
    if (gameOverShown) return;
    gameOverShown = true;      // sensör ve kalp atışı zamanlayıcıları bu bayrakla durur
    controlRejected = true;    // gönderimi keser
    clearInterval(gameOverCheck);
    clearInterval(leaderInterval);

    ['nameOverlay', 'tutorialOverlay'].forEach(id => { document.getElementById(id).style.display = 'none'; });
    const ui = document.getElementById('gameUI');
    ui.style.display = 'block';
    ui.innerHTML = `
        <div style="text-align:center; padding: 40px 20px;">
            <h1 style="color:#FF9900; font-size:32px; margin-bottom:20px;">Bu oyunda başka bir oyuncu var</h1>
            <p style="font-size:18px; color:#545B64; margin-bottom: 20px;">Bu QR koduyla şu an başka bir telefon oynuyor.</p>
            <p style="font-size:16px; color:#545B64;">Oyun bitince monitörde yeni bir QR kod çıkacak,<br><b>onu okutarak</b> sıranı al.</p>
        </div>
    `;
}

// İşleyiciyi sayfa yüklenince bağla: oda doluysa isim ekranındaki telefon da hemen haber alır
onRoomBusy = showBusy;

/** Oyun bitti ekranını gösterir. MQTT sinyali ve Shadow yoklaması aynı fonksiyonu çağırır. */
function showGameOver() {
    if (gameOverShown) return;
    gameOverShown = true;
    clearInterval(gameOverCheck);
    clearInterval(leaderInterval);
    releaseScreen();

    document.getElementById('gameUI').innerHTML = `
        <div style="text-align:center; padding: 40px 20px;">
            <h1 style="color:#D13212; font-size:40px; margin-bottom:20px;">OYUN BİTTİ! 🚀</h1>
            <p style="font-size:20px; color:#545B64; margin-bottom: 20px;">Oynadığın için teşekkürler!</p>
            <p style="font-size:16px; color:#545B64; margin-bottom: 20px;">Tekrar denemek için ekrandaki QR'ı yeniden okut.</p>
            <p style="font-size:16px; color:#545B64;">Bu sekme diğer oyunculara yer açmak için<br><b>3 saniye içinde</b> otomatik kapatılacaktır.</p>
        </div>
    `;

    // 3 saniye sonra sekmeyi kapatmayı dene, olmazsa AWS sayfasına yönlendir.
    // Bazı mobil tarayıcılar (ör. Safari) QR ile açılan sekmelerde window.close()'a izin verir,
    // izin vermeyenlerde yönlendirme bir nevi "çıkış" görevi görür.
    setTimeout(() => {
        window.close();
        window.location.href = "https://aws.amazon.com/tr/";
    }, 3000);
}

// ─── Ekran Açık Tutma ─────────────────────────────────────────────────────────
// Kumanda dokunmadan eğim ile kullanılır; telefon ekranı kendiliğinden kapanmasın.
// NoSleep.js: Wake Lock API (Android, iOS 16.4+) varsa onu, yoksa gizli video yöntemini kullanır.
// Kullanıcı dokunuşu içinde başlatılmalı (iOS/Android kuralı); bu yüzden "Hazırım" butonundan çağrılır.
let noSleep = null;
let screenKeepWanted = false;

function keepScreenOn() {
    screenKeepWanted = true;
    try {
        if (!noSleep && typeof NoSleep !== 'undefined') noSleep = new NoSleep();
        if (noSleep && !noSleep.isEnabled) {
            const p = noSleep.enable();
            if (p && p.catch) p.catch(() => {});
        }
    } catch (e) {}
}

function releaseScreen() {
    screenKeepWanted = false;
    try { if (noSleep) noSleep.disable(); } catch (e) {}
}

// Sekme arka plandan dönünce kilit (sistem tarafından bırakılmış olabilir) yeniden alınır
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !screenKeepWanted || !noSleep) return;
    try {
        const p = noSleep.enable();
        if (p && p.catch) p.catch(() => {});
    } catch (e) {}
});

// ─── Oyuna Başla ──────────────────────────────────────────────────────────────

/**
 * Giriş ekranını kapatır, oyun ekranını açar ve sensörü başlatır.
 * @param {string} name - Doğrulanmış oyuncu adı
 */
function startPlaying(name) {
    PLAYER_NAME = name;

    // UI geçişi: isim ekranı → öğretici (oyun arayüzü altta hazır bekler)
    document.getElementById('nameOverlay').style.display     = 'none';
    document.getElementById('gameUI').style.display          = 'block';
    document.getElementById('pNameVal').innerText            = PLAYER_NAME;
    document.getElementById('tutorialOverlay').style.display = 'flex';

    // Skor listesi oyun başında bir kez çekilir (her 10 sn'de tüm tabloyu taramak gereksiz DynamoDB okuması)
    fetchLeaderboard(false, PLAYER_NAME);

    // Oyun bitti sinyali: önce MQTT push (anında), yedek olarak Shadow yoklaması (her 10 sn; MQTT sinyali zaten anında gelir)
    onGameOverSignal = showGameOver;
    gameOverCheck = setInterval(() => {
        if (!iotData) return;
        iotData.getThingShadow({ thingName: ODA_ID }, (err, data) => {
            if (err) return;
            try {
                const payload = JSON.parse(data.payload.toString());
                const d = payload.state && payload.state.desired;
                if (d && d.gameOver && (!d.owner || d.owner === DEVICE_ID)) showGameOver();
            } catch(e) {}
        });
    }, 10000);

}

// ─── Öğretici → Sensör ────────────────────────────────────────────────────────

/**
 * "Hazırım" butonuna basılınca öğreticiyi kapatır ve sensörü başlatır.
 * iOS sensör izni kullanıcı dokunuşu içinde istenmek zorunda; bu yüzden izin istemi buraya bağlı.
 */
document.getElementById('tutReadyBtn').addEventListener('click', () => {
    document.getElementById('tutorialOverlay').style.display = 'none';
    keepScreenOn();

    // Sensör olayını beklemeden monitöre "oyuncu hazır" sinyali ver (oyun başlar, 4 sn ısınma var)
    startHeartbeat();

    // iOS: Sensör izni gerekiyor
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(state => {
                if (state === 'granted') startSensing();
                else alert('Sensör izni reddedildi!');
            })
            .catch(console.error);
    } else {
        // Android / web: izin gerekmez
        startSensing();
    }
});

// ─── Gyroscope Okuma ──────────────────────────────────────────────────────────

// Hassasiyet: telefondaki eğim bu çarpanla büyütülüp küçültülür (kişiye göre ayar).
const SENS_LEVELS = { low: 0.7, normal: 1.0, high: 1.3 };
let sensGain = SENS_LEVELS.normal;
try {
    const savedSens = localStorage.getItem('awsracer_sens');
    if (SENS_LEVELS[savedSens]) sensGain = SENS_LEVELS[savedSens];
} catch (e) {}

function applySensButtons() {
    document.querySelectorAll('.sens-btn').forEach(btn => {
        btn.classList.toggle('active', SENS_LEVELS[btn.dataset.sens] === sensGain);
    });
}
document.querySelectorAll('.sens-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        sensGain = SENS_LEVELS[btn.dataset.sens];
        try { localStorage.setItem('awsracer_sens', btn.dataset.sens); } catch (e) {}
        applySensButtons();
    });
});
applySensButtons();

let lastOutTilt   = 0; // Telefondan en son gönderilen eğim (kalp atışı bunu tekrarlar)

/**
 * Telefonun sağ kenarının yataydan ne kadar aşağıda olduğunu (°) verir. Sağa eğim pozitif.
 *
 * Neden gamma değil: gamma, telefonun öne/arkaya yatıklığına (beta) bağlıdır. Aynı gerçek
 * eğim, telefon dik tutulunca 2-3 kat büyük gamma verir; ekran biraz arkaya yatırılınca
 * (beta > 90°) gamma işaret değiştirir ve kumanda ters yöne gider.
 * Sağ kenarın dünya eksenindeki dikey bileşeni her duruşta doğrudur:
 *     aşağı eğim = asin( sin(gamma) · cos(beta) )
 */
function steeringAngle(beta, gamma) {
    if (beta === null || beta === undefined) return gamma; // beta yoksa eski davranış
    const b = beta * Math.PI / 180;
    const g = gamma * Math.PI / 180;
    const s = Math.max(-1, Math.min(1, Math.sin(g) * Math.cos(b)));
    return Math.asin(s) * 180 / Math.PI;
}

/**
 * Telefon eğim verisini okur, tilt çubuğunu günceller ve AWS'ye gönderir.
 */
function startSensing() {
    window.addEventListener('deviceorientation', (event) => {
        if (gameOverShown) return; // Oyun bitti ekranında arayüz öğeleri yok, gönderim de gerekmiyor
        if (event.gamma === null) return;
        const rawGamma = steeringAngle(event.beta, event.gamma); // Sağa/sola eğim açısı (°), duruştan bağımsız

        // EMA Filtresi: Sensördeki titremeleri ve ani sıçramaları temizler
        // Olay hızından bağımsız EMA: katsayı geçen süreye göre ölçeklenir (60 Hz'de tam SENSOR_SMOOTH)
        const nowMs  = performance.now();
        const evDt   = lastSensorTime ? Math.max(0.25, Math.min((nowMs - lastSensorTime) / (1000 / 60), 4)) : 1;
        lastSensorTime = nowMs;
        const alpha  = 1 - Math.pow(1 - SENSOR_SMOOTH, evDt);
        smoothedGamma = (rawGamma * alpha) + (smoothedGamma * (1 - alpha));

        // Tilt değerini ekranda göster
        document.getElementById('tiltDisplay').innerText = `Eğim: ${Math.round(smoothedGamma)}°`;

        // Direksiyon çubuğunu güncelle
        updateTiltBar(smoothedGamma);

        // AWS'ye filtrelenmiş veriyi gönder
        lastOutTilt = Math.round(smoothedGamma * sensGain);
        sendDataToAWS(lastOutTilt, PLAYER_NAME);
    });
}

/**
 * Sensör olayı gelmese bile (telefon sabit, izin bekliyor) monitöre düzenli sinyal yollar.
 * İlk sinyal oyunu başlatır; bu olmadan hiç sensör olayı gelmezse monitör bekleme ekranında kalırdı.
 */
function startHeartbeat() {
    sendDataToAWS(lastOutTilt, PLAYER_NAME);
    const hb = setInterval(() => {
        if (gameOverShown) { clearInterval(hb); return; }
        sendDataToAWS(lastOutTilt, PLAYER_NAME);
    }, 300);
}

/**
 * Görsel tilt çubuğunu eğim açısına göre günceller.
 * @param {number} gamma - Eğim açısı (-90 ile +90 arası)
 */
function updateTiltBar(gamma) {
    const pct  = Math.min(Math.abs(gamma), 45) / 45 * 50; // 0–50% genişlik
    const fill = document.getElementById('tiltFill');

    if (gamma > 0) {
        // Sağa eğim: turuncu
        fill.style.marginLeft = '50%';
        fill.style.width      = pct + '%';
        fill.style.background = 'linear-gradient(90deg, #FF9900, #ff5500)';
    } else {
        // Sola eğim: mavi
        fill.style.marginLeft = (50 - pct) + '%';
        fill.style.width      = pct + '%';
        fill.style.background = 'linear-gradient(90deg, #0095ff, #00A1C9)';
    }
}
