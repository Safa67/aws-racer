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
let controlRejected = false; // Oda başka bir telefona aitse true: bu telefon artık veri göndermez
let onGameOverSignal = null;
let onRoomBusy = null;       // kumanda-ui.js atar: oda başka bir telefona ait // kumanda-ui.js atar: monitörden gelen "oyun bitti" sinyali

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
        if (lastHbAt) lastHbAt = Date.now(); // yeniden bağlandık: bekçiye taze süre ver
        staleIgnoreUntil = Date.now() + 2500; // monitörün eski "eğim yok" yaşı yeni bağlantıyı yenileme döngüsüne sokmasın
        client.subscribe(`awsracer/${ODA_ID}/state`, { qos: 0 });
        // Odaya katıldığımızı bildir: oda doluysa monitör hemen "oda dolu" cevabı verir
        client.publish(`awsracer/${ODA_ID}/tilt`, JSON.stringify({ join: true, deviceId: DEVICE_ID }), { qos: 0 });
    });

    client.on('message', (topic, message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.hb) {
                // Monitörün canlılık sinyali (yalnızca odanın sahibine anlamlı)
                if (data.owner !== DEVICE_ID) return;
                lastHbAt = Date.now();
                // Monitör son eğimi çok önce almış: bu telefonun gönderim yönü kopmuş, bağlantıyı yenile
                if (data.age > HB_STALE_AGE_MS && Date.now() > staleIgnoreUntil) forceMqttReconnect('monitör eğim almıyor (' + data.age + ' ms)');
            } else if (data.busy && data.deviceId === DEVICE_ID) {
                if (onRoomBusy) onRoomBusy();
            } else if (data.gameOver && (!data.owner || data.owner === DEVICE_ID) && onGameOverSignal) {
                onGameOverSignal(); // oyun bitti ekranı yalnızca odanın sahibine
            }
        } catch (e) {}
    });

    client.on('error', (err) => console.error('Telefon MQTT hatası:', err));

    client.on('close', () => {
        if (phoneMqtt !== client) return;
        client.end(true);
        setTimeout(connectPhoneMqtt, 2000);
    });
}

// ─── Bağlantı Bekçisi (yarım kopmuş WebSocket) ────────────────────────────────
// Mobil ağda WebSocket kopsa da tarayıcı bunu ~45 sn fark etmeyebilir ('close' gelmez); o sürede eğim kaybolurdu.
// Monitör oyun sırasında her saniye canlılık sinyali yollar. Sinyal gelmezse ya da monitör "eğim almıyorum"
// derse bağlantı yenilenir; yenilenirken eğim Shadow (REST) yedeğiyle gitmeye devam eder.
const HB_TIMEOUT_MS   = 3500;  // Bu kadar süre sinyal gelmezse bağlantı ölü sayılır
const HB_STALE_AGE_MS = 3000;  // Monitörün son eğimi bu kadar önce aldığını bildirmesi: gönderim yönü ölü
let lastHbAt = 0;              // 0: henüz sinyal gelmedi (oyun başlamadı), bekçi kapalı
let staleIgnoreUntil = 0;      // Bu zamana kadar monitörün "eğim yok" yaşı yok sayılır (yeni bağlantıya süre tanır)

function forceMqttReconnect(reason) {
    if (!phoneMqtt) return;
    console.warn('Telefon MQTT yenileniyor:', reason);
    lastHbAt = Date.now();     // yenileme sırasında art arda tetiklenmesin
    phoneMqtt.end(true);       // 'close' olayı taze imzayla yeniden bağlanmayı başlatır
}

setInterval(() => {
    if (!lastHbAt || controlRejected) return;
    if (typeof gameOverShown !== 'undefined' && gameOverShown) return;
    if (phoneMqtt && phoneMqtt.connected && Date.now() - lastHbAt > HB_TIMEOUT_MS) {
        forceMqttReconnect('monitörden canlılık sinyali gelmiyor');
    }
}, 1000);

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
    if (controlRejected) return;
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

    // Bu çağrı doğrudan gönderilecek: bekleyen eski değer (trailing) varsa iptal et, yoksa daha sonra
    // eski değeri yeni değerin ARDINDAN gönderip yönü ters çevirebilir.
    clearTimeout(pendingSend);

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

        // Bir yarışmacı = bir cihaz (aynı ismi kullanan farklı cihazlar ayrı satırdır)
        const bestByPlayer = {};
        items.filter(item => !isTesterName(item.PlayerName) && !isProfane(item.PlayerName)).forEach(item => {
            const key = playerKey(item);
            if (!bestByPlayer[key] || item.Score > bestByPlayer[key][1]) {
                bestByPlayer[key] = [item.PlayerName, item.Score, key, deviceTag(item)];
            }
        });

        const top10 = Object.values(bestByPlayer)
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
            top10.forEach(([name, score, key, tag], idx) => {
                const isMe = key === 'd:' + DEVICE_ID;
                htmlStr += `<li class="${isMe ? 'me' : ''}"${tag ? ' data-tag="1" style="cursor:pointer;"' : ''}>
                    <span class="rank">${idx + 1}.</span>
                    <span style="flex:1; padding: 0 5px;">${isMe ? '⭐ ' : ''}${escapeHtml(name)}${deviceTagHtml(tag)}</span>
                    <span class="player-score">${score}</span>
                </li>`;
            });

            document.getElementById('phoneLeaderList').innerHTML =
                htmlStr || '<li style="color:#545B64; text-align:center">Henüz skor yok!</li>';
            document.getElementById('lbUpdate').innerText = timestamp + "'de güncellendi";
        }
    });
}
