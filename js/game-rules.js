/**
 * game-rules.js — Monitör ve kumandanın ortak oyun kuralları
 *
 * Not: Bu dosya herkese açık sunulur, buradaki değerler gizli değildir.
 */

// Bir cihazın etkinlikteki toplam oyun hakkı
const MAX_ATTEMPTS = 3;

// Sınırsız oynayabilen deneme/geliştirici isimleri.
// - Hak sınırı ve "isim başkasına ait" kontrolü uygulanmaz (her cihazdan kullanılabilir).
// - Skorları kaydedilir ama skor tablolarında gösterilmez (ödül sıralamasını bozmasın).
const TESTER_NAMES = ['deneyici1234'];

function isTesterName(name) {
    return TESTER_NAMES.indexOf(name) !== -1;
}
