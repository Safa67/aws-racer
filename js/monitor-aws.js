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
/** Tablodaki tüm kayıtları sayfalayarak çeker (Scan tek seferde en fazla 1 MB döner). */
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

/** Bugünün tarihi (YYYY-MM-DD, monitör bilgisayarının yerel saati). */
function todayKey() {
    return new Date().toLocaleDateString('sv-SE');
}

/** Kayıt listesinden isim başına en iyi skoru bulup ilk 10'u <li> olarak yazar. */
function renderBoard(listId, items, emptyText) {
    // Aynı isimde birden fazla kayıt olabilir (oyuncular 3 hakka kadar oynar): en yüksek skor sayılır.
    const bestByName = {};
    items.filter(item => !isTesterName(item.PlayerName) && !isProfane(item.PlayerName)).forEach(item => {
        if (!bestByName[item.PlayerName] || item.Score > bestByName[item.PlayerName]) {
            bestByName[item.PlayerName] = item.Score;
        }
    });

    const top10 = Object.entries(bestByName)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    let htmlStr = '';
    top10.forEach(([name, score], idx) => {
        htmlStr += `<li><b>${idx + 1}.</b> ${escapeHtml(name)} <span style="float:right; color:#FF9900; font-weight:bold;">${score}</span></li>`;
    });

    document.getElementById(listId).innerHTML = htmlStr || `<li>${emptyText}</li>`;
}

// Bugünün oyuncu başına en iyi skorları ({name, score}); canlı sıra hesabı için önbellek.
// Ek tarama yapılmaz: tablo zaten her oyun sonunda ve açılışta taranıyor.
let dailyBests = [];

/**
 * Oyun sırasında anlık skorun günün tablosundaki yerini verir.
 * Oyuncunun kendi önceki kayıtları dışarıda bırakılır (oyun bitince yerine yenisi geçer).
 * @returns {{rank:number, total:number}}
 */
function liveRankFor(screenScore) {
    const others = dailyBests.filter(b => b.name !== activePlayerName);
    return {
        rank:  1 + others.filter(b => b.score > screenScore).length,
        total: others.length + 1,
    };
}

/** Tüm zamanlar ve günün skor tablolarını tek taramayla günceller. */
function fetchLeaderboard() {
    if (!dynamoClient) return;

    scanAll({ TableName: AWS_CONFIG.dynamoTable }, function (err, items) {
        if (err) {
            console.error('Leaderboard hatası:', err);
            document.getElementById('leaderList').innerHTML = '<li>AWS Bekleniyor...</li>';
            return;
        }

        renderBoard('leaderList', items, 'Skor Listesi Boş!');

        // Günün tablosu: sadece bugün oynanan kayıtlar (eski kayıtlarda Day alanı yok, sayılmaz)
        const today = todayKey();
        const todays = items.filter(item => item.Day === today);
        renderBoard('dailyList', todays, 'Bugün henüz skor yok!');

        // Canlı sıra için bugünün en iyi skorları (deneme hesapları sayılmaz)
        const best = {};
        todays.filter(item => !isTesterName(item.PlayerName) && !isProfane(item.PlayerName)).forEach(item => {
            if (!(item.PlayerName in best) || item.Score > best[item.PlayerName]) best[item.PlayerName] = item.Score;
        });
        dailyBests = Object.keys(best).map(name => ({ name: name, score: best[name] }));
    });
}

// ─── Game Callbacks (monitor-game.js tarafından çağrılır) ────────────────────

/**
 * Oyun bitince çağrılır. Skoru DynamoDB'ye kaydeder.
 * activePlayerName değişkeni monitor-mqtt.js içinde yönetilir.
 * @param {number} finalScore - Hesaplanmış final skoru
 */
function onGameOver(finalScore) {
    // Resmi hızdan (DEFAULT_TIME_SCALE) farklı test hızında skorlar karşılaştırılamaz; tabloya yazılmaz
    if (typeof timeScale !== 'undefined' && timeScale !== DEFAULT_TIME_SCALE) {
        console.info('Test hızı aktif (' + timeScale + 'x): skor kaydedilmedi.');
    } else if (activePlayerName !== 'Anonim') {
        // Skor artık tarayıcıdan DynamoDB'ye değil, doğrulayan bir Lambda'ya gönderilir
        // (OWASP A01: tarayıcı konsolundan sahte skor yazma açığı). Bkz. lambda/submit-score/.
        fetch(AWS_CONFIG.scoreApiUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                playerName: activePlayerName,
                score:      finalScore,
                deviceId:   activeDeviceId || 'bilinmiyor',
                playedMs:   Math.round((typeof playSec !== 'undefined' ? playSec : 0) * 1000),
                roomId:     ODA_ID,
            }),
        })
            .then((res) => res.json().catch(() => ({})).then((data) => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
                if (ok) { fetchLeaderboard(); return; } // Kaydedince leaderboard'u hemen güncelle
                console.warn('Skor kaydedilmedi:', data && data.reason);
            })
            .catch((err) => console.error('Skor API hatası:', err));
    }

    // Oyuncu bilgilerini sıfırla
    activePlayerName = 'Anonim';
    activeDeviceId   = null;
    document.getElementById('playerVal').innerText = 'Anonim';
}

/**
 * Oyun sıfırlanınca çağrılır.
 * Yeni oda ID'si oluşturur, QR'ı ve MQTT aboneliğini günceller.
 */
function onGameReset() {
    lockedDeviceId = null;   // yeni oda, kilitsiz başlar
    lastBusyNotify = {};
    ODA_ID = 'awsracer-' + Math.floor(Math.random() * 1000000);
    renderQR();
    subscribeToRoom(ODA_ID); // monitor-mqtt.js — yeni odanın topic'ine geç
}
