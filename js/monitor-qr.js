/**
 * monitor-qr.js — QR Kod Yöneticisi (Monitor tarafı)
 *
 * Oyuncu bekleme ekranında gösterilen QR kodunu oluşturur ve günceller.
 * Yeni bir oda açıldığında (resetGame sonrası) QR otomatik yenilenir.
 *
 * Bağımlılıklar: qrcodejs (CDN), config.js
 */

let qrcodeInstance = null;

/**
 * QR kodu içeren overlay'i gösterir ve QR'ı (yeniden) oluşturur.
 * ODA_ID değişkeni monitor-aws.js tarafından sağlanır.
 */
function renderQR() {
    document.getElementById('qrOverlay').style.display = 'block';

    // Şu anki URL'den kumanda.html adresini türet ve oda kodunu ekle
    const baseUrl = window.location.href.split('?')[0].replace('Monitor.html', 'kumanda.html');
    const joinUrl = baseUrl + '?room=' + ODA_ID;

    if (!qrcodeInstance) {
        qrcodeInstance = new QRCode(document.getElementById('qrcode'), {
            text:         joinUrl,
            width:        220,
            height:       220,
            correctLevel: QRCode.CorrectLevel.L,
        });
    } else {
        // Mevcut QR'ı temizle ve yeni URL ile yeniden oluştur
        qrcodeInstance.clear();
        qrcodeInstance.makeCode(joinUrl);
    }
}
