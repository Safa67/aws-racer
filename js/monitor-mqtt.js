/**
 * monitor-mqtt.js — AWS IoT MQTT WebSocket Bağlantısı
 *
 * HTTP polling (her 40ms'de bir istek) yerine MQTT push modeli kullanır.
 * Telefon shadow'u güncellediği AN monitör mesajı alır — polling gecikmesi sıfır.
 *
 * Mimari farkı:
 *   ESKİ: Monitör → GET /shadow → Frankfurt → response → Monitör  (200ms+ her seferinde)
 *   YENİ: Telefon → MQTT publish → Frankfurt → push → Monitör     (sadece ağ gecikmesi)
 *
 * Bağımlılıklar:
 *   - config.js       (AWS_CONFIG)
 *   - monitor-game.js (gameStarted, isGameOver, startGame, setTargetSpeed)
 *   - mqtt.js CDN     (global mqtt objesi)
 *   - aws-sdk CDN     (AWS.config.credentials — Cognito'dan geliyor)
 *
 * Gerektirdiği ek IAM izinleri (Cognito Unauth rolüne eklenecek):
 *   iot:Connect, iot:Subscribe, iot:Receive
 */

// Oyuncu adı — hem bu modül (MQTT mesajında güncellenir)
// hem de monitor-aws.js (DynamoDB kaydında kullanılır) tarafından okunur.
let activePlayerName = 'Anonim';
// Oda kilidi: ilk kontrol mesajını gönderen telefon odanın sahibi olur. Başka telefonların mesajları
// yok sayılır ve onlara "oda dolu" bilgisi gönderilir (QR'ı aynı anda okutan iki kişi birbirini bozmasın).
let lockedDeviceId   = null;
let lastBusyNotify   = {};   // deviceId → son bildirim zamanı (ms), mesaj yağmurunu önler
let activeDeviceId   = null; // Telefonun rastgele cihaz kodu (3 hak kuralı için skorla birlikte saklanır)

// ─── MQTT Bağlantı Yöneticisi ─────────────────────────────────────────────────

let mqttClient  = null;
let activeTopic = null; // Şu an abone olunan shadow topic
let activeTiltTopic = null; // Şu an abone olunan doğrudan tilt topic'i (düşük gecikme yolu)

/**
 * Cognito kimlik doğrulaması tamamlandıktan sonra çağrılır.
 * MQTT WebSocket bağlantısını kurar ve olay dinleyicilerini ayarlar.
 */
async function startMqtt() {
    let url;
    try {
        url = await createMqttWebSocketUrl();
    } catch (e) {
        console.error('MQTT URL oluşturulamadı (SigV4 hatası):', e);
        document.getElementById('status').innerText   = 'MQTT Başlatma Hatası ⛔';
        document.getElementById('status').style.color = '#FF4F4F';
        return;
    }

    const client = mqtt.connect(url, {
        // clientId: AWS'nin tanıyabileceği benzersiz bir ID
        clientId:        'monitor-' + Math.random().toString(36).slice(2, 10),
        protocol:        'wss',
        keepalive:       30,   // 30sn'de bir canlı tut ping'i
        reconnectPeriod: 0,    // Otomatik yeniden bağlanma kapalı: eski imzalı URL süresi dolar,
                               // 'close' olayında taze imzayla kendimiz bağlanırız.
        connectTimeout:  8000,
    });
    mqttClient = client;

    mqttClient.on('connect', () => {
        console.log('AWS IoT MQTT WebSocket bağlandı!');
        document.getElementById('status').innerText   = 'AWS IoT MQTT: AKTİF 🟢';
        document.getElementById('status').style.color = '#00FF00';
        subscribeToRoom(ODA_ID); // Mevcut odanın shadow güncellemelerini dinle
    });

    // Telefon shadow'u her güncellediğinde bu fonksiyon tetiklenir
    mqttClient.on('message', _handleMqttMessage);

    let retryScheduled = false; // end() 'close'u tekrar tetikleyebilir; yinelenen bağlantıları önler
    client.on('close', () => {
        if (mqttClient !== client || retryScheduled) return;
        retryScheduled = true;
        console.warn('MQTT bağlantısı koptu, 3 sn sonra taze imzayla yeniden bağlanılacak.');
        document.getElementById('status').innerText   = 'MQTT Yeniden Bağlanıyor... 🟡';
        document.getElementById('status').style.color = '#FF9900';
        client.end(true);
        setTimeout(startMqtt, 3000);
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT hatası:', err);
        document.getElementById('status').innerText   = 'MQTT Bağlantı Hatası ⛔';
        document.getElementById('status').style.color = '#FF4F4F';
    });
}

/**
 * Yeni bir oda ID'si için shadow topic'e abone olur.
 * Önceki odadan otomatik olarak çıkış yapar (reset sonrası kullanılır).
 * @param {string} odaId - Abone olunacak oda ID'si
 */
function subscribeToRoom(odaId) {
    if (!mqttClient || !mqttClient.connected) return;

    // Önceki odanın topic'inden çık
    if (activeTopic) {
        mqttClient.unsubscribe(activeTopic);
        console.log('Abonelik iptal edildi:', activeTopic);
    }
    if (activeTiltTopic) mqttClient.unsubscribe(activeTiltTopic);

    // AWS IoT Device Shadow güncelleme topic'i:
    // '$aws/things/<thingName>/shadow/update/accepted'
    // → Telefon updateThingShadow çağırdığında ve AWS kabul ettiğinde tetiklenir
    activeTopic = `$aws/things/${odaId}/shadow/update/accepted`;
    mqttClient.subscribe(activeTopic, { qos: 0 }, (err) => {
        if (err) console.error('MQTT abonelik hatası:', err);
        else     console.log('MQTT abone olundu:', activeTopic);
    });

    // Düşük gecikme yolu: telefon Shadow servisini atlayıp bu topic'e doğrudan MQTT publish eder.
    activeTiltTopic = `awsracer/${odaId}/tilt`;
    mqttClient.subscribe(activeTiltTopic, { qos: 0 }, (err) => {
        if (err) console.error('Tilt topic abonelik hatası:', err);
    });
}

// ─── Game Over Sinyali ────────────────────────────────────────────────────────
function broadcastGameOver() {
    if (!mqttClient || !mqttClient.connected) return;
    // Telefona anında it (telefon 3 sn'lik shadow yoklamasını beklemez)
    // owner: oyun bitti ekranı yalnızca odanın sahibine gösterilir
    mqttClient.publish(`awsracer/${ODA_ID}/state`, JSON.stringify({ gameOver: true, owner: lockedDeviceId }), { qos: 0, retain: false });
    const payload = JSON.stringify({ state: { desired: { gameOver: true, owner: lockedDeviceId } } });
    mqttClient.publish(`$aws/things/${ODA_ID}/shadow/update`, payload, { qos: 0 }, (err) => {
        if (err) console.error('GameOver sinyali gönderilemedi:', err);
        else console.log('GameOver sinyali gönderildi.');
    });
}

// ─── Mesaj İşleyici ──────────────────────────────────────────────────────────

/**
 * MQTT'den gelen shadow güncelleme mesajını ayrıştırır ve oyunu günceller.
 * Polling olmadığı için bu fonksiyon telefon veri gönderdiği an tetiklenir.
 *
 * @param {string} topic   - Mesajın geldiği topic (bilgi amaçlı)
 * @param {Buffer} message - Ham MQTT mesajı (JSON içerir)
 */
/** Odanın sahibi olmayan bir telefona "oda dolu" bilgisi yollar (cihaz başına en fazla 2 sn'de bir). */
function _notifyBusy(deviceId) {
    const now = Date.now();
    if (now - (lastBusyNotify[deviceId] || 0) < 2000) return;
    lastBusyNotify[deviceId] = now;
    if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`awsracer/${ODA_ID}/state`, JSON.stringify({ busy: true, deviceId: deviceId }), { qos: 0 });
    }
}

function _handleMqttMessage(topic, message) {
    try {
        const payload = JSON.parse(message.toString());
        // Doğrudan topic: düz { tilt, playerName }. Shadow topic: { state: { desired: {...} } }.
        const desired = topic.startsWith('awsracer/') ? payload : (payload.state && payload.state.desired);
        if (!desired) return;

        // ── Tek kontrolcü kilidi ──────────────────────────────────────────
        const senderId = desired.deviceId ? String(desired.deviceId).slice(0, 64) : 'bilinmiyor';

        if (desired.join) {
            // Telefon odaya katıldı: oda zaten başka birine aitse hemen haber ver
            if (lockedDeviceId !== null && lockedDeviceId !== senderId) _notifyBusy(senderId);
            return;
        }

        if (desired.tilt !== undefined) {
            if (lockedDeviceId === null) lockedDeviceId = senderId;   // ilk kontrol mesajı odayı kilitler
            if (lockedDeviceId !== senderId) { _notifyBusy(senderId); return; }
        } else if (lockedDeviceId !== null && lockedDeviceId !== senderId) {
            return; // sahibi olmayan telefonun diğer mesajları (ör. ad) da yok sayılır
        }

        // ── Oyuncu Adı ────────────────────────────────────────────────────
        if (desired.playerName && desired.playerName !== activePlayerName) {
            activePlayerName = desired.playerName;
            document.getElementById('playerVal').innerText = activePlayerName;
        }

        if (desired.deviceId && desired.deviceId !== activeDeviceId) {
            activeDeviceId = String(desired.deviceId).slice(0, 64);
        }

        // ── Oyun Kontrolü ──────────────────────────────────────────────────
        if (desired.tilt !== undefined) {
            // İlk tilt verisi gelince oyunu başlat
            if (!gameStarted && !isGameOver) startGame();

            // Kavisli Duyarlılık: Küçük eğimlerde yüksek hassasiyet, büyük eğimlerde güç.
            // (Math.pow ile doğrusal olmayan bir ivmelenme sağlanır)
            // Kavisli Duyarlılık: Küçük eğimlerde yüksek hassasiyet, büyük eğimlerde güç.
            // (Math.pow ile doğrusal olmayan bir ivmelenme sağlanır)
            const rawTilt     = desired.tilt;
            const sensitivity = 7.2;
            const exponent    = 1.12;
            const curvedSpeed = Math.sign(rawTilt) * Math.pow(Math.abs(rawTilt), exponent) / sensitivity;

            setTargetSpeed(curvedSpeed);
        }

    } catch (e) {
        console.error('MQTT mesajı işlenirken hata:', e);
    }
}
