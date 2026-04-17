/**
 * monitor-aws.js — AWS Bağlantısı (Monitor Tarafı)
 *
 * Şunları yönetir:
 *   1. Cognito ile AWS kimlik doğrulama
 *   2. MQTT bağlantısını başlatma (monitor-mqtt.js'e devredilir)
 *   3. DynamoDB leaderboard güncelleme ve görüntüleme
 *
 * Bağımlılıklar: config.js, monitor-game.js, monitor-qr.js, monitor-mqtt.js, aws-sdk
 *
 * monitor-game.js tarafından çağrılan callback'ler:
 *   onGameOver(finalScore)  — skoru DynamoDB'ye kaydeder
 *   onGameReset()           — yeni oda ID'si oluşturur, QR ve MQTT aboneliğini yeniler
 */

// --- AWS istemcileri ---
let iotData      = null; // Shadow güncelleme için (kumanda tarafından kullanılıyor, monitör okumaz artık)
let dynamoClient = null;

// Oda ID'si: her resetGame'de güncellenir, monitor-mqtt.js subscribeToRoom() ile takip eder
let ODA_ID = 'awsracer-' + Math.floor(Math.random() * 1000000);

// ─── AWS Kimlik Doğrulama ─────────────────────────────────────────────────────

AWS.config.region      = AWS_CONFIG.region;
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: AWS_CONFIG.cognitoPoolId,
});

AWS.config.credentials.get(function (err) {
    if (err) {
        document.getElementById('status').innerText   = 'Yetki Hatası (Konsola bak)';
        document.getElementById('status').style.color = 'red';
        console.error('Cognito Hatası:', err);
        return;
    }

    dynamoClient = new AWS.DynamoDB.DocumentClient();

    console.log('Cognito kimliği alındı. MQTT bağlantısı başlatılıyor...');
    document.getElementById('status').innerText   = 'AWS Bağlanıyor... 🟡';
    document.getElementById('status').style.color = '#FF9900';

    // QR ve leaderboard'u hemen göster
    renderQR();
    fetchLeaderboard();

    // REST polling yerine MQTT WebSocket kullan (monitor-mqtt.js)
    startMqtt();
});

// ─── DynamoDB Leaderboard ─────────────────────────────────────────────────────

/**
 * Tüm skorları DynamoDB'den çekip sıralı olarak gösterir.
 */
function fetchLeaderboard() {
    if (!dynamoClient) return;

    dynamoClient.scan({ TableName: AWS_CONFIG.dynamoTable }, function (err, data) {
        if (err) {
            console.error('Leaderboard hatası:', err);
            document.getElementById('leaderList').innerHTML = '<li>AWS Bekleniyor...</li>';
            return;
        }

        // Aynı isimde birden fazla kayıt olabilir (oyuncular tekrar oynayabilir).
        // Her oyuncu için sadece en yüksek skor gösterilir.
        const bestByName = {};
        data.Items.forEach(item => {
            if (!bestByName[item.PlayerName] || item.Score > bestByName[item.PlayerName]) {
                bestByName[item.PlayerName] = item.Score;
            }
        });

        const top10 = Object.entries(bestByName)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        let htmlStr = '';
        top10.forEach(([name, score], idx) => {
            htmlStr += `<li><b>${idx + 1}.</b> ${name} <span style="float:right; color:#FF9900; font-weight:bold;">${score}</span></li>`;
        });

        document.getElementById('leaderList').innerHTML = htmlStr || '<li>Skor Listesi Boş!</li>';
    });
}

// ─── Game Callbacks (monitor-game.js tarafından çağrılır) ────────────────────

/**
 * Oyun bitince çağrılır. Skoru DynamoDB'ye kaydeder.
 * activePlayerName değişkeni monitor-mqtt.js içinde yönetilir.
 * @param {number} finalScore - Hesaplanmış final skoru
 */
function onGameOver(finalScore) {
    if (dynamoClient && activePlayerName !== 'Anonim') {
        dynamoClient.put({
            TableName: AWS_CONFIG.dynamoTable,
            Item: {
                SessionId:  ODA_ID,
                PlayerName: activePlayerName,
                Score:      finalScore,
            },
        }, function (err) {
            if (!err) fetchLeaderboard(); // Kaydedince leaderboard'u hemen güncelle
        });
    }

    // Oyuncu bilgilerini sıfırla
    activePlayerName = 'Anonim';
    document.getElementById('playerVal').innerText = 'Anonim';
}

/**
 * Oyun sıfırlanınca çağrılır.
 * Yeni oda ID'si oluşturur, QR'ı ve MQTT aboneliğini günceller.
 */
function onGameReset() {
    ODA_ID = 'awsracer-' + Math.floor(Math.random() * 1000000);
    renderQR();
    subscribeToRoom(ODA_ID); // monitor-mqtt.js — yeni odanın topic'ine geç
}
