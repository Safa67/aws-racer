/**
 * submit-score — AWS Lambda (Node.js 20.x runtime, @aws-sdk/client-dynamodb dahil gelir, npm install gerekmez)
 *
 * Amaç: Skor yazımını tarayıcıdan sunucuya taşımak. Önceden monitör, Cognito kimliksiz rolüyle
 * DynamoDB'ye doğrudan `PutItem` yapıyordu; tarayıcı konsolundan herkes rastgele bir skor
 * yazabiliyordu. Bu Lambda'dan sonra tarayıcının DynamoDB'ye YAZMA izni tamamen kaldırılır
 * (yalnızca Scan/okuma kalır); yazma yalnızca bu fonksiyonun yürütme rolünden yapılabilir.
 *
 * Doğrulama (OWASP A01 bulgusu, "makul oran kontrolü" kapsamı — kullanıcıyla konuşulup seçildi):
 *   - İsim: 1-15 karakter, js/game-rules.js'deki küfür filtresiyle aynı mantık (bkz. isProfane).
 *   - Skor/süre oranı: ekranda görünen skor, bildirilen oyun süresine göre MAX_RATE_PER_SEC ve
 *     BURST_ALLOWANCE ile sınırlanan cömert bir üst sınırı aşamaz. Bu sınır, oyunun gerçek kural
 *     sabitlerinden (js/monitor-game.js: BASIC_POINTS, STREAK_TIERS, NEAR_MISS_POINTS, LOGO_COUNT)
 *     EMPIRIK olarak türetildi; oyunu birebir yeniden simüle etmez. Amaç "tarayıcı konsolundan tek
 *     satırla sahte skor yazma" saldırısını kapatmaktır; kendi sahte istemcisini yazan gelişmiş bir
 *     saldırganı tam engellemez — bunun tam çözümü oyunu sunucuda tam simüle etmek olurdu, bu basit
 *     stant oyunu için orantısız. Ödül verirken monitörden en yüksek skoru gözle doğrulamak hâlâ önerilir.
 *   - deviceId: zorunlu, boş olamaz (3 hak kuralı zaten istemci+DynamoDB taramasıyla uygulanıyor,
 *     burada yalnızca alanın var olduğu kontrol edilir).
 *   - playedMs: 1 sn ile 10 dakika arasında olmalı (oyun kuralı gereği süre arttıkça zorlaşır,
 *     gerçekçi bir oyun bu aralıkta biter).
 *
 * İstek: POST { playerName, score, deviceId, playedMs, roomId }
 * Yanıt: 200 { ok:true } | 400 { ok:false, reason } | 500 { ok:false, reason:'server_error' }
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.DYNAMO_TABLE || 'AwsRacerScores';

// ─── Cömert skor/süre sınırı (bkz. üstteki açıklama) ──────────────────────────
const MAX_RATE_PER_SEC   = 50;   // Ölçülen gerçek üst sınır ~36 puan/sn (seri x3 + EC2); güvenlik payı bırakıldı
const BURST_ALLOWANCE    = 600;  // Logo Yağmuru (14 logo, ~4 sn) + ramak kala gibi patlamalar için
const MIN_PLAYED_MS      = 1000;
const MAX_PLAYED_MS      = 10 * 60 * 1000;
const MAX_NAME_LEN       = 15;

// ─── Küfürlü isim filtresi (js/game-rules.js ile aynı mantık, sunucu tarafında tekrarlanır) ──
const PROFANITY_TOKENS = ['amk', 'aq', 'mk', 'sik', 'sikik', 'sikim', 'got', 'gotu', 'pic', 'pust', 'oc', 'bok', 'amcik',
    'ibne', 'yarak', 'yarrak', 'fck', 'fuk', 'dick', 'cock', 'cunt', 'sex', 'rape', 'fag', 'slut', 'gerizekali', 'mal'];
const PROFANITY_ROOTS = ['siktir', 'sikeyim', 'sikis', 'orospu', 'oruspu', 'amcik', 'pezevenk', 'gavat', 'kahpe',
    'kaltak', 'surtuk', 'tasak', 'serefsiz', 'gotveren', 'boktan', 'fuck', 'shit', 'bitch', 'asshole', 'nigg', 'whore',
    'pussy', 'dickhead', 'motherf', 'faggot', 'porn'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '€': 'e' };

const collapse = (str) => str.replace(/(.)\1+/g, '$1');

function normalizeName(name) {
    let t = String(name).toLocaleLowerCase('tr').replace(/ı/g, 'i');
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    t = t.replace(/[013457389@$!€]/g, (ch) => LEET[ch]);
    return t.replace(/[^a-z]/g, ' ');
}

const PROF_TOKENS_SET = new Set(PROFANITY_TOKENS.map(collapse));
const PROF_ROOTS = PROFANITY_ROOTS.map(collapse);

function isProfane(name) {
    const tokens = normalizeName(name).split(/\s+/).filter(Boolean).map(collapse);
    const compact = collapse(tokens.join(''));
    if (tokens.some((t) => PROF_TOKENS_SET.has(t))) return true;
    if (PROF_TOKENS_SET.has(compact)) return true;
    return PROF_ROOTS.some((root) => compact.indexOf(root) !== -1);
}

// ─── DynamoDB ──────────────────────────────────────────────────────────────
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*', // Statik site, Cognito dışı gizli bilgi taşımaz; kısıtlamak istersen Amplify alan adıyla değiştir
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function respond(status, bodyObj) {
    return { statusCode: status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) };
}

exports.handler = async (event) => {
    if (event.requestContext && event.requestContext.http && event.requestContext.http.method === 'OPTIONS') {
        return respond(200, {});
    }

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch (e) {
        return respond(400, { ok: false, reason: 'invalid_json' });
    }

    const playerName = typeof body.playerName === 'string' ? body.playerName.trim() : '';
    const score      = Number(body.score);
    const deviceId   = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    const playedMs   = Number(body.playedMs);
    const roomId     = typeof body.roomId === 'string' ? body.roomId.trim() : '';

    if (!playerName || playerName.length > MAX_NAME_LEN) return respond(400, { ok: false, reason: 'invalid_name_length' });
    if (isProfane(playerName)) return respond(400, { ok: false, reason: 'invalid_name_profane' });
    if (!deviceId) return respond(400, { ok: false, reason: 'missing_device_id' });
    if (!roomId) return respond(400, { ok: false, reason: 'missing_room_id' });
    if (!Number.isFinite(score) || score < 0 || !Number.isInteger(score)) return respond(400, { ok: false, reason: 'invalid_score' });
    if (!Number.isFinite(playedMs) || playedMs < MIN_PLAYED_MS || playedMs > MAX_PLAYED_MS) return respond(400, { ok: false, reason: 'invalid_played_ms' });

    const maxAllowed = Math.ceil(MAX_RATE_PER_SEC * (playedMs / 1000) + BURST_ALLOWANCE);
    if (score > maxAllowed) {
        console.warn('Skor reddedildi (oran aşıldı):', { playerName, score, playedMs, maxAllowed });
        return respond(400, { ok: false, reason: 'score_rate_exceeded' });
    }

    const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

    try {
        await ddb.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                SessionId:  roomId,
                PlayerName: playerName,
                Score:      score,
                DeviceId:   deviceId,
                Day:        today,
                PlayedAt:   Date.now(),
            },
        }));
        return respond(200, { ok: true });
    } catch (e) {
        console.error('DynamoDB yazma hatası:', e);
        return respond(500, { ok: false, reason: 'server_error' });
    }
};
