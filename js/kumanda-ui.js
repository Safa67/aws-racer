/**
 * kumanda-ui.js — Kumanda Arayüzü ve Sensör Yönetimi
 *
 * Şunları yönetir:
 *   1. İsim doğrulama (DynamoDB'de aynı isim var mı kontrolü)
 *   2. Giriş → Oyun ekranı geçişi
 *   3. Gyroscope sensörü okuma ve tilt çubuğu güncelleme
 *   4. Oyun sırasında leaderboard periyodik yenileme
 *
 * Bağımlılıklar: kumanda-aws.js (iotData, dynamoClient, sendDataToAWS, fetchLeaderboard)
 */

let PLAYER_NAME      = '';
let leaderInterval   = null; // Oyun içi leaderboard yenileme zamanlayıcısı
let smoothedGamma    = 0;    // Filtrelenmiş eğim verisi
const SENSOR_SMOOTH  = 0.25; // EMA katsayısı (0.1: çok yumuşak/yavaş, 0.8: sert/hızlı)

// ─── Bağlan Butonu ────────────────────────────────────────────────────────────

document.getElementById('connectBtn').addEventListener('click', () => {
    const inputName = document.getElementById('playerNameInput').value.trim();
    const nameError = document.getElementById('nameError');
    nameError.innerText = '';

    // Temel doğrulama
    if (!inputName)            { nameError.innerText = '⚠️ Lütfen bir isim girin!'; return; }
    if (inputName.length > 15) { nameError.innerText = '⚠️ İsim en fazla 15 karakter olabilir!'; return; }
    if (!dynamoClient)         { nameError.innerText = '⏳ AWS bağlantısı bekleniyor...'; return; }

    // İsim kontrolü kaldırıldı: Aynı kişi tekrar oynayabilmeli.
    // Leaderboard sadece en yüksek skoru gösterir (fetchLeaderboard içinde gruplandırılır).
    nameError.style.color = '#00FF00';
    nameError.innerText   = '✅ Bağlanılıyor...';
    setTimeout(() => startPlaying(inputName), 400);
});

// ─── Oyuna Başla ──────────────────────────────────────────────────────────────

/**
 * Giriş ekranını kapatır, oyun ekranını açar ve sensörü başlatır.
 * @param {string} name - Doğrulanmış oyuncu adı
 */
function startPlaying(name) {
    PLAYER_NAME = name;

    // UI geçişi
    document.getElementById('nameOverlay').style.display = 'none';
    document.getElementById('gameUI').style.display      = 'block';
    document.getElementById('pNameVal').innerText        = PLAYER_NAME;

    // Oyun sırasında leaderboard'u 10 saniyede bir yenile
    leaderInterval = setInterval(() => fetchLeaderboard(false, PLAYER_NAME), 10000);

    // Oyun bitti mi diye AWS Shadow'u kontrol et (her 3 saniyede 1)
    const gameOverCheck = setInterval(() => {
        if (!iotData) return;
        iotData.getThingShadow({ thingName: ODA_ID }, (err, data) => {
            if (err) return;
            try {
                const payload = JSON.parse(data.payload.toString());
                if (payload.state && payload.state.desired && payload.state.desired.gameOver) {
                    clearInterval(gameOverCheck);
                    clearInterval(leaderInterval);
                    
                    // Ekranı güncelle
                    document.getElementById('gameUI').innerHTML = `
                        <div style="text-align:center; padding: 40px 20px;">
                            <h1 style="color:#D13212; font-size:40px; margin-bottom:20px;">OYUN BİTTİ! 🚀</h1>
                            <p style="font-size:20px; color:#545B64; margin-bottom: 20px;">Oynadığın için teşekkürler!</p>
                            <p style="font-size:16px; color:#545B64;">Bu sekme diğer oyunculara yer açmak için<br><b>10 saniye içinde</b> otomatik kapatılacaktır.</p>
                        </div>
                    `;
                    
                    // 10 saniye sonra sekmeyi kapatmayı dene, olmazsa AWS sayfasına yönlendir.
                    // Bazı mobil tarayıcılar (ör. Safari) QR ile açılan sekmelerde window.close()'a izin verir,
                    // izin vermeyenlerde yönlendirme bir nevi "çıkış" görevi görür.
                    setTimeout(() => {
                        window.close();
                        window.location.href = "https://aws.amazon.com/tr/";
                    }, 10000);
                }
            } catch(e) {}
        });
    }, 3000);

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
}

// ─── Gyroscope Okuma ──────────────────────────────────────────────────────────

/**
 * Telefon eğim verisini okur, tilt çubuğunu günceller ve AWS'ye gönderir.
 */
function startSensing() {
    window.addEventListener('deviceorientation', (event) => {
        const rawGamma = event.gamma; // Sağa/sola eğim açısı (°)
        if (rawGamma === null) return;

        // EMA Filtresi: Sensördeki titremeleri ve ani sıçramaları temizler
        smoothedGamma = (rawGamma * SENSOR_SMOOTH) + (smoothedGamma * (1 - SENSOR_SMOOTH));

        // Tilt değerini ekranda göster
        document.getElementById('tiltDisplay').innerText = `Eğim: ${Math.round(smoothedGamma)}°`;

        // Direksiyon çubuğunu güncelle
        updateTiltBar(smoothedGamma);

        // AWS'ye filtrelenmiş veriyi gönder
        sendDataToAWS(Math.round(smoothedGamma), PLAYER_NAME);
    });
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
