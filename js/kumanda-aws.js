/**
 * kumanda-aws.js — AWS Bağlantısı (Kumanda Tarafı)
 *
 * Şunları yönetir:
 *   1. Cognito ile AWS kimlik doğrulama
 *   2. Tilt verisini AWS IoT'ye gönderme (doğrudan MQTT; yedek: Device Shadow REST)
 *   3. DynamoDB'den leaderboard çekme
 *
 * Bağımlılıklar: config.js, aws-sdk
 * Dışa aktarılanlar: iotData, dynamoClient, sendDataToAWS(), fetchLeaderboard()
 */

// URL'den oda kodunu al (?room=awsracer-XXXXXX)
const urlParams = new URLSearchParams(window.location.search);
const ODA_ID = urlParams.get('room');

// Oda kodu yoksa bağlantıyı tamamen durdur (QR olmadan giriş engeli)
if (!ODA_ID) {
    document.getElementById('status').innerHTML = '❌ İZİNSİZ GİRİŞ!<br><br>Lütfen oyuna katılmak için ana ekrandaki QR Kodu okutun.';
    document.getElementById('status').style.color = '#FF4F4F';
    throw new Error('Oda numarası bulunamadı, bağlantı durduruldu.');
}

// --- Cihaz kodu ve hak sayısı ---
// Rastgele bir kod bu tarayıcıda saklanır; kişiyi tanımlamaz, sadece "aynı telefon" olduğunu gösterir.
// Tarayıcı verisi silinirse yeni kod üretilir (bilinçli olarak parmak izi/takip yapılmaz).
const MAX_ATTEMPTS = 3; // Bir cihazın etkinlikteki toplam oyun hakkı
const DEVICE_ID = (() => {
    try {
        let id = localStorage.getItem('awsracer_device');
        if (!id) {
            id = (crypto.randomUUID ? crypto.randomUUID() : 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36));
            localStorage.setItem('awsracer_device', id);
        }
        return id;
    } catch (e) {
        return 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
})();

// --- AWS durum değişkenleri ---
let iotData      = null; // Shadow güncelleme için (bu modülde init edilir; kumanda-ui.js tarafından okunur)
let dynamoClient = null;

// Gönderme sıklığı: en az 33ms aralık (~30Hz). Aynı değer tekrar gönderilmez (heartbeat hariç).
const SEND_INTERVAL_MS  = 33;
const HEARTBEAT_MS      = 250;
let lastSendTime  = 0;
let lastSentTilt  = null;
let pendingSend   = null; // Throttle'a takılan son değeri bırakmamak için (trailing send)

// Doğrudan MQTT bağlantısı (Shadow REST yoluna göre daha düşük gecikme)
let phoneMqtt = null;
let onGameOverSignal = null; // kumanda-ui.js atar: monitörden gelen "oyun bitti" sinyali

// ─── AWS Kimlik Doğrulama ─────────────────────────────────────────────────────

AWS.config.region = AWS_CONFIG.region;
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: AWS_CONFIG.cognitoPoolId,
});

AWS.config.credentials.get(function (err) {
    if (err) {
        document.getElementById('status').innerText = 'Yetki Hatası: (Konsola bak)';
        document.getElementById('status').style.color = 'red';
        console.error('Cognito Hatası:', err);
        return;
    }

    iotData = new AWS.IotData({ endpoint: AWS_CONFIG.iotEndpoint });
    dynamoClient = new AWS.DynamoDB.DocumentClient();

    console.log('Kumanda AWS\'ye bağlandı!');
    document.getElementById('status').innerText = "AWS'ye Bağlandı! 🚀";
    document.getElementById('status').style.color = '#00FF00';

    // Giriş ekranında da leaderboard önizlemesini göster
    fetchLeaderboard(true);

    connectPhoneMqtt();
});

// ─── Doğrudan MQTT (düşük gecikme) ────────────────────────────────────────────

/**
 * Telefonu AWS IoT'ye MQTT WebSocket ile bağlar. Eğim verisi Shadow REST çağrısı yerine
 * `awsracer/<oda>/tilt` topic'ine publish edilir. Bağlantı yoksa REST yolu yedek olarak kalır.
 * Kopma olursa her denemede taze imzalı URL ile yeniden bağlanır.
 */
async function connectPhoneMqtt() {
    if (typeof mqtt === 'undefined') return;

    let url;
    try {
        url = await createMqttWebSocketUrl();
    } catch (e) {
        console.error('Telefon MQTT URL hatası:', e);
        setTimeout(connectPhoneMqtt, 3000);
        return;
    }

    const client = mqtt.connect(url, {
        clientId:        'phone-' + Math.random().toString(36).slice(2, 10),
        protocol:        'wss',
        keepalive:       30,
        reconnectPeriod: 0, // eski imzalı URL süresi dolar; 'close'ta taze imzayla kendimiz bağlanırız
        connectTimeout:  8000,
    });
    phoneMqtt = client;

    client.on('connect', () => {
        client.subscribe(`awsracer/${ODA_ID}/state`, { qos: 0 });
    });

    client.on('message', (topic, message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.gameOver && onGameOverSignal) onGameOverSignal();
        } catch (e) {}
    });

    client.on('error', (err) => console.error('Telefon MQTT hatası:', err));

    client.on('close', () => {
        if (phoneMqtt !== client) return;
        client.end(true);
        setTimeout(connectPhoneMqtt, 2000);
    });
}

// ─── IoT Shadow Veri Gönderme ─────────────────────────────────────────────────

/**
 * Eğim verisini ve oyuncu adını gönderir.
 * Öncelik: doğrudan MQTT publish (düşük gecikme). MQTT hazır değilse Shadow REST yedeği.
 * En fazla ~30 kez/sn gönderilir; throttle'a takılan son değer kaybolmaz (trailing send).
 *
 * @param {number} tiltValue  - Telefon eğim açısı (derece)
 * @param {string} playerName - Oyuncu adı
 */
function sendDataToAWS(tiltValue, playerName) {
    const mqttReady = phoneMqtt && phoneMqtt.connected;
    if (!mqttReady && !iotData) return;

    // ±2 derece denge payı: çok hafif titremeleri ve drift'i engeller
    if (tiltValue > -2 && tiltValue < 2) tiltValue = 0;

    const now  = Date.now();
    const wait = SEND_INTERVAL_MS - (now - lastSendTime);
    if (wait > 0) {
        // Çok yakın zamanda gönderildi: en güncel değeri aralık dolunca gönder
        clearTimeout(pendingSend);
        pendingSend = setTimeout(() => sendDataToAWS(tiltValue, playerName), wait);
        return;
    }

    // Değer değişmediyse sadece heartbeat aralığında tekrar gönder (maliyet + bant genişliği)
    if (tiltValue === lastSentTilt && now - lastSendTime < HEARTBEAT_MS) return;

    lastSendTime = now;
    lastSentTilt = tiltValue;

    // sentAt: Telefonun veriyi yazdığı an (ms) — uçtan uca gecikme ölçümü için.
    if (mqttReady) {
        phoneMqtt.publish(
            `awsracer/${ODA_ID}/tilt`,
            JSON.stringify({ tilt: tiltValue, playerName: playerName, deviceId: DEVICE_ID, sentAt: now }),
            { qos: 0 }
        );
        return;
    }

    const payload = JSON.stringify({
        state: { desired: { tilt: tiltValue, playerName: playerName, deviceId: DEVICE_ID, sentAt: now } },
    });
    iotData.updateThingShadow({ thingName: ODA_ID, payload: payload }, function (err) {
        if (err) console.error('Shadow güncelleme hatası:', err);
    });
}

// ─── DynamoDB Yardımcıları ────────────────────────────────────────────────────

/** Tablodaki kayıtları sayfalayarak çeker (Scan tek seferde en fazla 1 MB döner). */
function scanAll(params, callback, acc) {
    acc = acc || [];
    dynamoClient.scan(params, function (err, data) {
        if (err) return callback(err);
        acc = acc.concat(data.Items || []);
        if (data.LastEvaluatedKey) {
            return scanAll(Object.assign({}, params, { ExclusiveStartKey: data.LastEvaluatedKey }), callback, acc);
        }
        callback(null, acc);
    });
}

/** HTML'e basılacak metni temizler (oyuncu adı kullanıcıdan gelir). */
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

// ─── DynamoDB Leaderboard ─────────────────────────────────────────────────────

/**
 * Leaderboard'u DynamoDB'den çeker.
 * @param {boolean} isPreview - true: giriş ekranı önizlemesi, false: oyun içi tam liste
 * @param {string}  myName    - Kendi satırını vurgulama için oyuncu adı
 */
function fetchLeaderboard(isPreview, myName) {
    if (!dynamoClient) return;

    const timestamp = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    scanAll({ TableName: AWS_CONFIG.dynamoTable }, function (err, items) {
        if (err) { console.error('Leaderboard hatası:', err); return; }

        // Giriş sırasında benzersiz isim zorunluluğu uygulanıyor (kumanda-ui.js).
        // Bu gruplama sadece beklenmedik çifte kayıtlara karşı güvenlik önlemi olarak tutulur.
        const bestByName = {};
        items.forEach(item => {
            if (!bestByName[item.PlayerName] || item.Score > bestByName[item.PlayerName]) {
                bestByName[item.PlayerName] = item.Score;
            }
        });

        const top10 = Object.entries(bestByName)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (isPreview) {
            // Giriş ekranı: sadece birinci oyuncuyu göster
            document.getElementById('leaderPreview').innerHTML = top10.length > 0
                ? `🏆 Şu an önde: <b style="color:#FF9900">${escapeHtml(top10[0][0])} (${top10[0][1]} puan)</b>`
                : 'Henüz hiç puan yok — ilk sen ol!';
        } else {
            // Oyun içi: tam liste (kendi satırı vurgulanır)
            let htmlStr = '';
            top10.forEach(([name, score], idx) => {
                const isMe = name === myName;
                htmlStr += `<li class="${isMe ? 'me' : ''}">
                    <span class="rank">${idx + 1}.</span>
                    <span style="flex:1; padding: 0 5px;">${isMe ? '⭐ ' : ''}${escapeHtml(name)}</span>
                    <span class="player-score">${score}</span>
                </li>`;
            });

            document.getElementById('phoneLeaderList').innerHTML =
                htmlStr || '<li style="color:#545B64; text-align:center">Henüz skor yok!</li>';
            document.getElementById('lbUpdate').innerText = timestamp + "'de güncellendi";
        }
    });
}
