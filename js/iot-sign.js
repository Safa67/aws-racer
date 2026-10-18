/**
 * iot-sign.js — AWS IoT MQTT WebSocket için SigV4 imzalı URL üretici
 *
 * Hem monitör hem kumanda tarafından kullanılır.
 * Bağımlılıklar: config.js (AWS_CONFIG), aws-sdk (AWS.config.credentials)
 */

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
    // Cognito geçici kimlik bilgisi süresi dolduysa yenile (stant gün boyu açık kalır)
    await new Promise((resolve, reject) =>
        AWS.config.credentials.get(err => (err ? reject(err) : resolve())));
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

