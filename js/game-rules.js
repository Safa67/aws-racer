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

// ─── Küfürlü isim filtresi ───────────────────────────────────────────────────
// Yöntem: ismi küçült, Türkçe harfleri ve aksanları sadeleştir, yaygın "leet" yazımlarını çöz (s1kt1r, 0rospu),
// tekrar eden harfleri tek yap (siiiktir), sonra üç yoldan ara:
//   1) TOKEN listesi: kısa/belirsiz kelimeler yalnızca TAM KELİME olarak eşleşir ("amk", "sik", "got"). Böylece
//      "Kamkaz", "Sikke", "Gotham" gibi masum isimler engellenmez.
//   2) Tüm ismin boşluksuz hali bir TOKEN ise ("a.m.k", "s i k") engellenir.
//   3) KÖK listesi: uzun ve belirgin kökler, boşluk/nokta ile bölünmüş olsa bile ("s i k t i r") boşluksuz halde aranır.
// Liste ihtiyaca göre buradan düzenlenebilir. Hiçbir filtre kusursuz değildir; etkinlikte skor tablosunu gözle kontrol edin.

const PROFANITY_TOKENS = ['amk', 'aq', 'mk', 'sik', 'sikik', 'sikim', 'got', 'gotu', 'pic', 'pust', 'oc', 'bok', 'amcik',
    'ibne', 'yarak', 'yarrak', 'fck', 'fuk', 'dick', 'cock', 'cunt', 'sex', 'rape', 'fag', 'slut', 'gerizekali', 'mal'];
const PROFANITY_ROOTS  = ['siktir', 'sikeyim', 'sikis', 'orospu', 'oruspu', 'amcik', 'pezevenk', 'gavat', 'kahpe',
    'kaltak', 'surtuk', 'tasak', 'serefsiz', 'gotveren', 'boktan', 'fuck', 'shit', 'bitch', 'asshole', 'nigg', 'whore',
    'pussy', 'dickhead', 'motherf', 'faggot', 'porn'];

const _LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '€': 'e' };

/** Ardışık tekrar eden harfleri tek yapar (siiiktir → siktir). */
function _collapse(str) { return str.replace(/(.)\1+/g, '$1'); }

/** İsmi karşılaştırma biçimine çevirir: küçük harf, aksansız, leet çözülmüş, harf dışı = boşluk. */
function _normalizeName(name) {
    let t = String(name).toLocaleLowerCase('tr').replace(/ı/g, 'i');
    t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    t = t.replace(/[013457389@$!€]/g, ch => _LEET[ch]);
    return t.replace(/[^a-z]/g, ' ');
}

const _PROF_TOKENS_SET = new Set(PROFANITY_TOKENS.map(_collapse));
const _PROF_ROOTS      = PROFANITY_ROOTS.map(_collapse);

/** İsim küfür/hakaret içeriyor mu? */
function isProfane(name) {
    const tokens  = _normalizeName(name).split(/\s+/).filter(Boolean).map(_collapse);
    const compact = _collapse(tokens.join(''));
    if (tokens.some(t => _PROF_TOKENS_SET.has(t))) return true;
    if (_PROF_TOKENS_SET.has(compact)) return true;
    return _PROF_ROOTS.some(root => compact.indexOf(root) !== -1);
}
