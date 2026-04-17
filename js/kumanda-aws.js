/**
 * kumanda-aws.js — AWS Bağlantısı (Kumanda Tarafı)
 *
 * Şunları yönetir:
 *   1. Cognito ile AWS kimlik doğrulama
 *   2. IoT Device Shadow'a tilt verisi gönderme
 *   3. DynamoDB'den leaderboard çekme
 *
 * Bağımlılıklar: config.js, aws-sdk
 * Dışa aktarılanlar: iotData, dynamoClient, sendDataToAWS(), fetchLeaderboard()
 */

// URL'den oda kodunu al (?room=awsracer-XXXXXX)
const urlParams = new URLSearchParams(window.location.search);
const ODA_ID    = urlParams.get('room');

// Oda kodu yoksa bağlantıyı tamamen durdur (QR olmadan giriş engeli)
if (!ODA_ID) {
    document.getElementById('status').innerHTML    = '❌ İZİNSİZ GİRİŞ!<br><br>Lütfen oyuna katılmak için ana ekrandaki QR Kodu okutun.';
    document.getElementById('status').style.color  = '#FF4F4F';
    throw new Error('Oda numarası bulunamadı, bağlantı durduruldu.');
}

// --- AWS durum değişkenleri ---
let iotData      = null;
let dynamoClient = null;

// Son gönderme zamanı (40ms tavanı için rate limiting)
let lastSendTime = 0;

// ─── AWS Kimlik Doğrulama ─────────────────────────────────────────────────────

AWS.config.region      = AWS_CONFIG.region;
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: AWS_CONFIG.cognitoPoolId,
});

AWS.config.credentials.get(function (err) {
    if (err) {
        document.getElementById('status').innerText    = 'Yetki Hatası: (Konsola bak)';
        document.getElementById('status').style.color  = 'red';
        console.error('Cognito Hatası:', err);
        return;
    }

    iotData      = new AWS.IotData({ endpoint: AWS_CONFIG.iotEndpoint });
    dynamoClient = new AWS.DynamoDB.DocumentClient();

    console.log('Kumanda AWS\'ye bağlandı!');
    document.getElementById('status').innerText    = "AWS'ye Bağlandı! 🚀";
    document.getElementById('status').style.color  = '#00FF00';

    // Giriş ekranında da leaderboard önizlemesini göster
    fetchLeaderboard(true);
});

// ─── IoT Shadow Veri Gönderme ─────────────────────────────────────────────────

/**
 * Eğim verisini ve oyuncu adını AWS IoT Device Shadow'a gönderir.
 * Saniyede en fazla ~25 kez gönderilir (40ms tavanı).
 *
 * @param {number} tiltValue  - Telefon eğim açısı (derece)
 * @param {string} playerName - Oyuncu adı
 */
function sendDataToAWS(tiltValue, playerName) {
    if (!iotData) return;

    const now = Date.now();
    if (now - lastSendTime < 75) return; // Rate limiting (Saniyede ~13-14 istek, maliyet tasarrufu)
    lastSendTime = now;

    // ±2 derece denge payı: çok hafif titremeleri ve drift'i engeller
    if (tiltValue > -2 && tiltValue < 2) tiltValue = 0;

    const payload = JSON.stringify({
        // sentAt: Telefonun veriyi yazdığı an (ms). Monitör bunu okuyarak
        // uçtan uca gecikmeyi (telefon → AWS → monitör) hesaplar.
        state: { desired: { tilt: tiltValue, playerName: playerName, sentAt: Date.now() } },
    });

    iotData.updateThingShadow({ thingName: ODA_ID, payload: payload }, function (err) {
        if (err) console.error('Shadow güncelleme hatası:', err);
    });
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

    dynamoClient.scan({ TableName: AWS_CONFIG.dynamoTable }, function (err, data) {
        if (err) { console.error('Leaderboard hatası:', err); return; }

        // Aynı oyuncu birden fazla oynayabilir — her ismin en yüksek skoru alınır.
        const bestByName = {};
        data.Items.forEach(item => {
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
                ? `🏆 Şu an önde: <b style="color:#FF9900">${top10[0][0]} (${top10[0][1]} puan)</b>`
                : 'Henüz hiç puan yok — ilk sen ol!';
        } else {
            // Oyun içi: tam liste (kendi satırı vurgulanır)
            let htmlStr = '';
            top10.forEach(([name, score], idx) => {
                const isMe = name === myName;
                htmlStr += `<li class="${isMe ? 'me' : ''}">
                    <span class="rank">${idx + 1}.</span>
                    <span style="flex:1; padding: 0 5px;">${isMe ? '⭐ ' : ''}${name}</span>
                    <span class="player-score">${score}</span>
                </li>`;
            });

            document.getElementById('phoneLeaderList').innerHTML =
                htmlStr || '<li style="color:#545B64; text-align:center">Henüz skor yok!</li>';
            document.getElementById('lbUpdate').innerText = timestamp + "'de güncellendi";
        }
    });
}
