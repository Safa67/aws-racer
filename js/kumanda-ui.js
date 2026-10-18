/**
 * kumanda-ui.js — Kumanda Arayüzü ve Sensör Yönetimi
 *
 * Şunları yönetir:
 *   1. İsim doğrulama (DynamoDB'de aynı isim var mı kontrolü)
 *   2. Giriş → Oyun ekranı geçişi
 *   3. Gyroscope sensörü okuma ve tilt çubuğu güncelleme
 *   4. Oyun sırasında leaderboard periyodik yenileme
 *
 * Bağımlılıklar: kumanda-aws.js (dynamoClient, sendDataToAWS, fetchLeaderboard, iotData, ODA_ID)
 */

let PLAYER_NAME      = '';
let ATTEMPTS_LEFT    = MAX_ATTEMPTS; // Bu oyun dahil kalan hak
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
    const connectBtn = document.getElementById('connectBtn');
    nameError.innerText = '';

    // Temel doğrulama
    if (!inputName)            { nameError.innerText = '⚠️ Lütfen bir isim girin!'; return; }
    if (inputName.length > 15) { nameError.innerText = '⚠️ İsim en fazla 15 karakter olabilir!'; return; }
    if (!dynamoClient)         { nameError.innerText = '⏳ AWS bağlantısı bekleniyor...'; return; }

    // Butonu devre dışı bırak (çift tıklamayı önle)
    connectBtn.disabled = true;
    nameError.style.color = '#FF9900';
    nameError.innerText = '🔍 İsim kontrol ediliyor...';

    // Deneme/geliştirici ismi: hak ve isim kontrolü yok, her cihazdan sınırsız oynanır
    if (isTesterName(inputName)) {
        ATTEMPTS_LEFT = Infinity;
        try { localStorage.setItem('awsracer_name', inputName); } catch (e) {}
        connectBtn.disabled = false;
        nameError.style.color = '#00FF00';
        nameError.innerText = '✅ Deneme hesabı: sınırsız hak — Bağlanılıyor...';
        setTimeout(() => startPlaying(inputName), 400);
        return;
    }

    // Bu isim başka bir cihaza mı ait? Bu cihaz kaç kez oynadı? (tek taramada ikisi birden)
    scanAll({
        TableName: AWS_CONFIG.dynamoTable,
        FilterExpression: 'PlayerName = :n OR DeviceId = :d',
        ExpressionAttributeValues: { ':n': inputName, ':d': DEVICE_ID }
    }, function (err, items) {
        connectBtn.disabled = false;

        if (err) {
            nameError.style.color = '#D13212';
            nameError.innerText = '❌ Sunucu hatası, tekrar dene!';
            console.error('İsim kontrolü hatası:', err);
            return;
        }

        const mine   = items.filter(i => i.DeviceId === DEVICE_ID);
        const others = items.filter(i => i.DeviceId !== DEVICE_ID && i.PlayerName === inputName);

        // İsim başka bir cihaza ait (veya eski, cihaz kodu olmayan bir kayıtta var)
        if (others.length > 0) {
            nameError.style.color = '#D13212';
            nameError.innerText = `❌ "${inputName}" ismi başkası tarafından kullanılıyor! Lütfen farklı bir isim girin.`;
            document.getElementById('playerNameInput').focus();
            return;
        }

        // Bu cihaz daha önce başka bir isimle oynadıysa aynı ismi kullanmak zorunda
        if (mine.length > 0 && mine[0].PlayerName !== inputName) {
            nameError.style.color = '#D13212';
            nameError.innerText = `❌ Bu telefonla daha önce "${mine[0].PlayerName}" ismiyle oynadın. Aynı ismi kullan.`;
            document.getElementById('playerNameInput').value = mine[0].PlayerName;
            return;
        }

        if (mine.length >= MAX_ATTEMPTS) {
            nameError.style.color = '#D13212';
            nameError.innerText = `❌ ${MAX_ATTEMPTS} oyun hakkını da kullandın. Oynadığın için teşekkürler!`;
            return;
        }

        ATTEMPTS_LEFT = MAX_ATTEMPTS - mine.length;
        try { localStorage.setItem('awsracer_name', inputName); } catch (e) {}

        nameError.style.color = '#00FF00';
        nameError.innerText = `✅ Kalan hakkın: ${ATTEMPTS_LEFT}/${MAX_ATTEMPTS} — Bağlanılıyor...`;
        setTimeout(() => startPlaying(inputName), 400);
    });
});

// ─── Oyun Bitti Ekranı ────────────────────────────────────────────────────────

let gameOverCheck = null; // Shadow yoklama zamanlayıcısı (MQTT sinyali gelmezse yedek)
let gameOverShown = false;

/** Oyun bitti ekranını gösterir. MQTT sinyali ve Shadow yoklaması aynı fonksiyonu çağırır. */
function showGameOver() {
    if (gameOverShown) return;
    gameOverShown = true;
    clearInterval(gameOverCheck);
    clearInterval(leaderInterval);

    document.getElementById('gameUI').innerHTML = `
        <div style="text-align:center; padding: 40px 20px;">
            <h1 style="color:#D13212; font-size:40px; margin-bottom:20px;">OYUN BİTTİ! 🚀</h1>
            <p style="font-size:20px; color:#545B64; margin-bottom: 20px;">Oynadığın için teşekkürler!</p>
            <p style="font-size:16px; color:#545B64; margin-bottom: 20px;">${ATTEMPTS_LEFT === Infinity
                ? 'Deneme hesabı: sınırsız hak — tekrar denemek için QR\'ı yeniden okut.'
                : ATTEMPTS_LEFT > 1
                ? 'Kalan hakkın: <b>' + (ATTEMPTS_LEFT - 1) + '/' + MAX_ATTEMPTS + '</b> — tekrar denemek için ekrandaki QR\'ı yeniden okut.'
                : 'Tüm oyun haklarını kullandın.'}</p>
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

    // Oyun sırasında leaderboard'u 10 saniyede bir yenile
    leaderInterval = setInterval(() => fetchLeaderboard(false, PLAYER_NAME), 10000);

    // Oyun bitti sinyali: önce MQTT push (anında), yedek olarak Shadow yoklaması (her 3 sn)
    onGameOverSignal = showGameOver;
    gameOverCheck = setInterval(() => {
        if (!iotData) return;
        iotData.getThingShadow({ thingName: ODA_ID }, (err, data) => {
            if (err) return;
            try {
                const payload = JSON.parse(data.payload.toString());
                if (payload.state && payload.state.desired && payload.state.desired.gameOver) showGameOver();
            } catch(e) {}
        });
    }, 3000);

}

// ─── Öğretici → Sensör ────────────────────────────────────────────────────────

/**
 * "Hazırım" butonuna basılınca öğreticiyi kapatır ve sensörü başlatır.
 * iOS sensör izni kullanıcı dokunuşu içinde istenmek zorunda; bu yüzden izin istemi buraya bağlı.
 */
document.getElementById('tutReadyBtn').addEventListener('click', () => {
    document.getElementById('tutorialOverlay').style.display = 'none';

    // Tuş modu seçildiyse sensör/izin gerekmez
    if (document.getElementById('padModeChk').checked) {
        startPadMode();
        return;
    }

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
let padMode       = false;

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

// ─── Yön Tuşları (isteğe bağlı) ───────────────────────────────────────────────

// Tuşa basılı tutuldukça hız artar: PAD_START (hafif) → PAD_MAX (tam hız), PAD_RAMP_MS içinde.
// Bırakınca ya da yön değişince başa döner. Eşdeğer eğim açısıdır (45° = en yüksek hız).
const PAD_START   = 12;
const PAD_MAX     = 45;
const PAD_RAMP_MS = 900;

/**
 * Eğim yerine ekrandaki ◀ ▶ tuşlarıyla oynamayı başlatır.
 * Basılı tutulan yön gönderilir (tuttukça hızlanır); bırakılınca 0. 50 ms'de bir tekrar gönderilir
 * (kopan paket tuşu takılı bırakmasın).
 */
function startPadMode() {
    padMode = true;
    let dir = 0;
    let pressedAt = 0; // Mevcut yönün basılma zamanı
    const left  = document.getElementById('padLeft');
    const right = document.getElementById('padRight');
    document.getElementById('padControls').style.display = 'flex';
    document.getElementById('sensRow').style.display  = 'none';
    document.querySelector('.tilt-label').innerText = '🎮 Tuşlarla yönlendir';

    const press = (d, btn) => (e) => {
        e.preventDefault();
        if (dir !== d) pressedAt = Date.now();
        dir = d;
        btn.classList.add('pressed');
    };
    const release = (btn) => (e) => {
        e.preventDefault();
        // Diğer tuş hâlâ basılıysa onun yönünü koru
        const prev = dir;
        if (btn === left && right.classList.contains('pressed')) dir = 1;
        else if (btn === right && left.classList.contains('pressed')) dir = -1;
        else dir = 0;
        if (dir !== prev) pressedAt = Date.now();
        btn.classList.remove('pressed');
    };
    [[left, -1], [right, 1]].forEach(([btn, d]) => {
        btn.addEventListener('pointerdown', press(d, btn));
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => btn.addEventListener(ev, release(btn)));
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    const padTimer = setInterval(() => {
        if (gameOverShown) { clearInterval(padTimer); return; }
        const held  = dir === 0 ? 0 : Math.min((Date.now() - pressedAt) / PAD_RAMP_MS, 1);
        const value = dir === 0 ? 0 : Math.round(dir * (PAD_START + (PAD_MAX - PAD_START) * held));
        document.getElementById('tiltDisplay').innerText = dir === 0 ? 'Tuş: -' : (dir < 0 ? 'Tuş: ◀' : 'Tuş: ▶');
        updateTiltBar(value);
        sendDataToAWS(value, PLAYER_NAME);
    }, 50);
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
