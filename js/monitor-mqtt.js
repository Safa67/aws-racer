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

// ─── SigV4 URL İmzalama (Web Crypto API) ─────────────────────────────────────
// AWS IoT MQTT WebSocket bağlantısı, standart HTTP auth header yerine
// URL parametrelerinde SigV4 imzası gerektirir.

/** HMAC-SHA256: key string veya Uint8Array olabilir */
async function _hmac(key, data) {
    const enc = new TextEncoder();
    const k   = typeof key === 'string' ? enc.encode(key) : key;
    const ck  = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', ck, enc.encode(data)));
}

/** Uint8Array → hex string */
const _toHex = (buf) => Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 hash → hex string */
async function _sha256hex(data) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return _toHex(new Uint8Array(hash));
}

/** Hiyerarşik SigV4 imzalama anahtarı üretir */
async function _getSigningKey(secretKey, date, region, service) {
    const kDate    = await _hmac('AWS4' + secretKey, date);
    const kRegion  = await _hmac(kDate, region);
    const kService = await _hmac(kRegion, service);
    return await _hmac(kService, 'aws4_request');
}

/**
 * AWS IoT MQTT WebSocket için SigV4 imzalı bağlantı URL'i oluşturur.
 * Cognito kimlik bilgileri (accessKeyId, secretAccessKey, sessionToken) kullanır.
 * @returns {Promise<string>} wss:// formatında imzalı URL
 */
async function createMqttWebSocketUrl() {
    const creds    = AWS.config.credentials;
    const region   = AWS_CONFIG.region;
    const endpoint = AWS_CONFIG.iotEndpoint;
    const service  = 'iotdevicegateway';
    const path     = '/mqtt';

    const now       = new Date();
    const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);                              // YYYYMMDD

    // Canonical query string — AWS SigV4 zorunluluğu: parametreler alfabetik sıralı
    const canonicalQS = [
        'X-Amz-Algorithm=AWS4-HMAC-SHA256',
        `X-Amz-Credential=${encodeURIComponent(`${creds.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`)}`,
        `X-Amz-Date=${amzDate}`,
        'X-Amz-SignedHeaders=host',
    ].join('&');

    const canonicalReq = [
        'GET',
        path,
        canonicalQS,
        `host:${endpoint}\n`,   // canonical headers (boş satır içerir)
        'host',                  // signed headers
        await _sha256hex(''),    // boş body hash'i
    ].join('\n');

    const credScope   = `${dateStamp}/${region}/${service}/aws4_request`;
    const strToSign   = ['AWS4-HMAC-SHA256', amzDate, credScope, await _sha256hex(canonicalReq)].join('\n');
    const signingKey  = await _getSigningKey(creds.secretAccessKey, dateStamp, region, service);
    const signature   = _toHex(await _hmac(signingKey, strToSign));

    // Cognito → geçici kimlik bilgisi → Session Token zorunlu
    const sessionParam = creds.sessionToken
        ? `&X-Amz-Security-Token=${encodeURIComponent(creds.sessionToken)}`
        : '';

    return `wss://${endpoint}${path}?${canonicalQS}&X-Amz-Signature=${signature}${sessionParam}`;
}

// ─── MQTT Bağlantı Yöneticisi ─────────────────────────────────────────────────

let mqttClient  = null;
let activeTopic = null; // Şu an abone olunan shadow topic

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

    mqttClient = mqtt.connect(url, {
        // clientId: AWS'nin tanıyabileceği benzersiz bir ID
        clientId:        'monitor-' + Math.random().toString(36).slice(2, 10),
        protocol:        'wss',
        keepalive:       30,   // 30sn'de bir canlı tut ping'i
        reconnectPeriod: 3000, // Bağlantı kopunca 3sn sonra yeniden dene
        connectTimeout:  8000,
    });

    mqttClient.on('connect', () => {
        console.log('AWS IoT MQTT WebSocket bağlandı!');
        document.getElementById('status').innerText   = 'AWS IoT MQTT: AKTİF 🟢';
        document.getElementById('status').style.color = '#00FF00';
        subscribeToRoom(ODA_ID); // Mevcut odanın shadow güncellemelerini dinle
    });

    // Telefon shadow'u her güncellediğinde bu fonksiyon tetiklenir
    mqttClient.on('message', _handleMqttMessage);

    mqttClient.on('reconnect', () => {
        document.getElementById('status').innerText   = 'MQTT Yeniden Bağlanıyor... 🟡';
        document.getElementById('status').style.color = '#FF9900';
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

    // AWS IoT Device Shadow güncelleme topic'i:
    // '$aws/things/<thingName>/shadow/update/accepted'
    // → Telefon updateThingShadow çağırdığında ve AWS kabul ettiğinde tetiklenir
    activeTopic = `$aws/things/${odaId}/shadow/update/accepted`;
    mqttClient.subscribe(activeTopic, { qos: 0 }, (err) => {
        if (err) console.error('MQTT abonelik hatası:', err);
        else     console.log('MQTT abone olundu:', activeTopic);
    });
}

// ─── Game Over Sinyali ────────────────────────────────────────────────────────
function broadcastGameOver() {
    if (!mqttClient || !mqttClient.connected) return;
    const payload = JSON.stringify({ state: { desired: { gameOver: true } } });
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
function _handleMqttMessage(topic, message) {
    try {
        const payload = JSON.parse(message.toString());
        const desired = payload.state && payload.state.desired;
        if (!desired) return;

        // ── Uçtan Uca Gecikme ─────────────────────────────────────────────
        // ── Ping Göstergesi ──────────────────────────────────────────────
        // payload.timestamp: AWS'nin mesajı işlediği an (saniye cinsinden, sunucu saati).
        // Date.now() - payload.timestamp*1000 = AWS Frankfurt → Monitör tek yönlü gecikme.
        // Bu yöntem sentAt'tan daha güvenilir: sadece AWS saati ile monitör saati kullanılır.
        if (payload.timestamp) {
            const awsToMonitor = Math.max(0, Date.now() - payload.timestamp * 1000);
            document.getElementById('pingVal').innerText = awsToMonitor + 'ms';
        }

        // ── Oyuncu Adı ────────────────────────────────────────────────────
        if (desired.playerName && desired.playerName !== activePlayerName) {
            activePlayerName = desired.playerName;
            document.getElementById('playerVal').innerText = activePlayerName;
        }

        // ── Oyun Kontrolü ──────────────────────────────────────────────────
        if (desired.tilt !== undefined) {
            // İlk tilt verisi gelince oyunu başlat
            if (!gameStarted && !isGameOver) startGame();
            // Eğimi harekete dönüştür (bölen ne kadar büyükse hareket o kadar yavaş olur)
            setTargetSpeed(desired.tilt / 7);
        }

    } catch (e) {
        console.error('MQTT mesajı işlenirken hata:', e);
    }
}
