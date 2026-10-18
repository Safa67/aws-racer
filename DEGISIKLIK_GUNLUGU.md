# AWS Racer: Değişiklik Günlüğü ve Teknik Notlar

Bu dosya, projeyi gözden geçirme ve geliştirme oturumunda yapılan her şeyi, nedenlerini, ölçümleri ve kalan işleri tek yerde toplar. Tarih: 18 Ekim 2026.

Canlı site (AWS Amplify, `main` dalı): `https://main.d308ipxr84hxtz.amplifyapp.com/Monitor.html`

## 1. Genel bakış

Oyun bir stant oyunudur. Monitördeki oyun (`Monitor.html`) bir QR kod gösterir. Oyuncu telefonuyla QR'ı okutur, `kumanda.html` açılır, telefonu eğerek (ya da ekrandaki ◀ ▶ tuşlarıyla) monitördeki bulutu yönlendirir. Haberleşme AWS IoT Core (MQTT), kimlik Amazon Cognito (kimliksiz rol), skorlar Amazon DynamoDB, barındırma AWS Amplify üzerindedir.

Oturumun başında proje Playwright ile gerçek tarayıcıda incelendi. Sonra sırasıyla gecikme, kontrol hissi, oyun kuralları ve test araçları üzerinde çalışıldı.

## 2. Commit listesi (`main`)

| Commit | Özet |
|---|---|
| `636595c` | Doğrudan MQTT, anlık "oyun bitti" sinyali, öğretici ekranı, ortak imzalama dosyası |
| `a374fab` | 3 haklı cihaz kodu, günlük skor tablosu, ısınma turu, yön tuşları, hassasiyet ayarı, XSS temizliği |
| `2b779b4` | Oyun başlamama riski, tuşlarda hızlanma, ısınmada etkisiz güçlendirici, eski kontrol hissine dönüş |
| `2093a78` | Oyun her ekran yenileme hızında aynı hızda çalışır |
| `5e136cb` | Telefon eğimi duruştan bağımsız, kalibrasyon kaldırıldı, `deneyici1234` hesabı |
| `6fafe13` | AWS logosu ekranda +50, yüzen puan yazıları, oyun hızı test butonları |

Eski yerel (commit edilmemiş) değişiklikler `git stash` içinde `stash@{0}` olarak duruyor (içinde bozuk bir regex de vardı, aşağıya bakın). İhtiyaç yoksa `git stash drop` ile silinebilir.

## 3. Başlangıç incelemesi: ne bulundu, neyi geri çektik

Playwright ile hem yerel kopya hem canlı site açıldı.

- Canlı sitede MQTT bağlanıyor, QR çiziliyor, liderlik tablosu geliyor. Sistem çalışıyordu.
- İlk listede iki madde yanlıştı ve geri çekildi:
  - "MQTT imza regex'i bozuk" sadece commit edilmemiş yerel kopyada vardı (yorum temizliği sırasında `\.` yerine `\\.` olmuş). GitHub'daki sürüm doğruydu.
  - "Dark tema kaydı yüklenmiyor" yanlıştı. Buton `<head>` içinde olduğu için tarayıcı `body`'yi erken oluşturuyor, hata atmıyordu.
- iOS sensör izni konusunda şüphe vardı. Kullanıcı 4 aydır iPhone ile sorunsuz oynandığını söyledi. Yine de izin istemi artık gerçek bir dokunuşa bağlandı.

## 4. Gecikme

### Ölçüm yöntemi
Telefon tarafı `sentAt` damgası yazar, monitör mesajı aldığı anda farkı hesaplar. İki Playwright tarayıcısıyla gerçek `eu-central-1` (Frankfurt) hattı üzerinden ölçüldü.

| | Önce (Shadow REST) | Sonra (doğrudan MQTT) |
|---|---|---|
| Eğim, medyan | 91 ms | 73–83 ms |
| "Oyun bitti" sinyali | 0–3000 ms (3 sn'de bir yoklama) | ~80 ms (anlık push) |

Taban gecikme internet gidiş-dönüşü. Kodla düşmesi sınırlı.

### Yapılanlar
- Telefon eğimi `$aws/things/<oda>/shadow/update` (REST) yerine MQTT ile `awsracer/<oda>/tilt` topic'ine yayınlar. MQTT hazır değilse eski REST yolu yedek kalır.
- Monitör iki topic'e abone: eski shadow topic'i ve yeni `awsracer/<oda>/tilt`. "Oyun bitti" sinyali `awsracer/<oda>/state` üzerinden telefona anında gider (3 sn'lik yoklama yedek olarak durur).
- İmzalama kodu `js/iot-sign.js` dosyasına taşındı. Hem monitör hem telefon kullanır.
- MQTT kopunca her denemede taze imzalı URL ile yeniden bağlanılır (`reconnectPeriod: 0` + `close` olayında kendi yeniden bağlanma). İmzalı URL eskiyince mqtt.js'in otomatik yeniden bağlanması başarısız olabiliyordu. Cognito süresi dolduysa imzalamadan önce yenilenir. `close` olayı `end()` ile tekrar tetiklenip çift bağlantı açabiliyordu, bu bir bayrakla engellendi.
- Gönderme aralığı 33 ms, aynı değer tekrar gönderilmez (250 ms heartbeat hariç), throttle'a takılan son değer kaybolmaz.
- Kullanılan IAM izinleri mevcut Cognito rolüyle yetti. AWS tarafında yeni izin gerekmedi.

### Kontrol hissi (geri alınan kısım)
Yumuşatmayı azaltmak (EMA 0.5, lerp 0.35) tepkiyi 117 ms'den 50 ms'ye indirdi ama kontrolü "sinirli" yaptı. Sonunda en baştaki değerlere dönüldü: telefon EMA 0.25, monitör lerp 0.25, eğri `açı^1.12 / 7.2`. Ölçülen ağ gecikmesi kazancı (doğrudan MQTT) korundu.

## 5. Oyun kuralları ve arayüz

### Öğretici
İsim girişinden sonra tek ekranlık "Nasıl Oynanır?" gösterilir. Sensör başlatma ve iOS izin istemi "Hazırım, Başla" dokunuşuna bağlıdır. Oyuncu okurken monitördeki oyun başlamaz.

### Oyun başlamama riski
Telefonda sensör olayı gelmezse (telefon sabit, tarayıcı olay yollamıyor) monitör bekleme ekranında kalabilirdi. Artık "Hazırım"a basınca sensörden bağımsız bir sinyal ve ardından 300 ms'de bir "kalp atışı" gönderilir. Bu yüzden oyun her durumda başlar.

### Isınma turu
Oyun başında 4 saniye engel çıkmaz. Bu sürede ne zaman puanı ne de güçlendirici etkisi işler. Monitörde "ISINMA: puan ve güçlendiriciler geçerli değil" yazar.

### 3 hak ve cihaz kodu
- Telefon, tarayıcıda rastgele bir cihaz kodu (`awsracer_device`) saklar. Kişiyi tanımlamaz, silinirse yenisi üretilir. Bilinçli olarak parmak izi yapılmadı (KVKK riski, bkz. bölüm 11).
- Her cihaz toplam 3 oyun oynayabilir. İsim başka bir cihaza aitse alınamaz. Aynı cihaz hep aynı ismi kullanmak zorundadır. İsim kutusu önceki isimle otomatik dolar.
- DynamoDB kayıtlarına şu alanlar eklenir: `DeviceId`, `Day` (YYYY-MM-DD, monitör bilgisayarının yerel günü), `PlayedAt` (ms).
- Telefon, kendi cihaz kodunu her eğim mesajıyla monitöre gönderir. Skoru monitör yazar.

### Günün skor tablosu
Monitörün sol sütununda "EN İYİ 10 (Genel)" ve altında "GÜNÜN EN İYİLERİ" gösterilir. Günlük tablo `Day` alanı bugüne eşit kayıtlardan oluşur. Eski kayıtlarda bu alan olmadığı için günlük tabloya girmez. Tarama artık `LastEvaluatedKey` ile sayfalanır (tek `scan` en fazla 1 MB döner, eski kod büyüyen tabloda eksik sonuç verebilirdi).

### Oyuncu adı güvenliği
İsimler tablolara basılmadan önce HTML'den arındırılır. Önceden `<img onerror=...>` gibi bir isim script çalıştırabilirdi (kayıtlı XSS).

### Deneme hesabı
`js/game-rules.js` içinde `TESTER_NAMES = ['deneyici1234']`. Bu isimle her cihazdan sınırsız oynanır, hak ve isim sahipliği kontrolü yoktur. Skorlar kaydedilir ama monitör ve telefon skor tablolarında gösterilmez. Bu dosya herkese açık sunulduğu için isim gizli değildir.

### Yön tuşları (isteğe bağlı)
Öğreticide "Eğmek yerine ekrandaki ◀ ▶ tuşlarıyla oyna" seçilirse iki büyük tuş çıkar. Sensör ve izin gerekmez. Basılı tutuldukça hız 12° eşdeğerinden 45°'ye 0.9 sn'de çıkar, bırakınca ya da yön değişince başa döner. Tuş basılı unutulmasın diye değer 50 ms'de bir tekrar gönderilir.

### Hassasiyet seçimi
Oyun ekranında Rahat / Normal / Hassas butonları (çarpan 0.7 / 1.0 / 1.3). Seçim tarayıcıda saklanır. Varsayılan Normal, yani orijinalle aynı. Tuş modunda gizlenir.

### Diğer
- "Oyun bitti" ekranından sonra sekme 3 saniyede kapanmayı dener (önceden 10 sn).
- Oyun bitince sensör ve tuş zamanlayıcıları durur (önceden silinmiş öğeleri güncellemeye çalışıp hata veriyordu).
- `endGame` ve skor mantığı `nextSpeedUp` eşiğine çevrildi (hızlanma kontrolü artık `score % 500 === 0` tesadüfüne bağlı değil).

## 6. Kare hızından bağımsız oyun (144 Hz sorunu)

Sorun: Hareket, düşme hızı, skor ve yumuşatma "kare başına" hesaplanıyordu. 144 Hz ekranda oyun gerçek zamanda 2.4 kat hızlı akıyordu. Bu orijinal kodda da vardı.

Çözüm: Tüm hızlar "60 fps'te kare başına" ayarlı kalır. Her karede geçen süre referans kareye oranlanır (`dt = geçen_ms / 16.67`, en fazla 3). Hareket `* dt`, lerp katsayısı `1 - 0.75^dt`, skor zamanla artar. Telefon EMA'sı sensör olay hızından bağımsız hale getirildi (60/120/200 Hz sensör aynı sonuç).

Ölçümler (ekran hızı tarayıcıda simüle edildi):

| | Eski, 144 Hz | Yeni, 30/60/144/240 Hz |
|---|---|---|
| Düşen engel hızı | 433 px/sn | 175–181 px/sn |
| Skor artışı | 143/sn | 60.1–60.3/sn |

Gerçek bir 144 Hz ekranda ve gerçek telefonda henüz denenmedi.

### Oyun hızı test butonları
Monitörün sol altında: Normal / 1.5x / 144 Hz hızı (2.4x). Seçim tarayıcıda saklanır. 1 dışındaki modlarda skor DynamoDB'ye yazılmaz. 144 Hz hızı, eski kodun 144 Hz'deki gerçek hızını yeniden üretir. Etkinlikten önce varsayılan seçilip butonlar gizlenmelidir.

## 7. Telefon eğimi: ters yön ve aşırı hassasiyet

Kök neden: Kod `event.gamma` kullanıyordu. `gamma`, telefonun öne/arkaya yatıklığına (`beta`) bağlıdır.

Aynı gerçek 20°'lik sağa eğim için monitör hızı (px/kare):

| Telefon duruşu (beta0) | Eski (gamma) | Yeni |
|---|---|---|
| Düz (0°) | ±4.0 | ±4.0 |
| Yatık (45°) | ±3.7 | ±2.7 |
| Dik (75°) | ±11.6 | ±3.8 |
| Dikey (90°) | ±21.4 | ±4.0 |
| Ekran biraz arkaya (100°) | ters, −14.3 | +4.0 |
| Ekran arkaya (120°) | ters, −6.4 | +3.3 |

Yani dik tutunca 2–5 kat hassas, ekran biraz arkaya yatınca kumanda ters yöne gider. Yeni formül telefonun sağ kenarının yataydan ne kadar aşağıda olduğunu verir:

    sağ kenar aşağı açısı = asin( sin(gamma) · cos(beta) )

Matris hesabıyla doğrulandı (2000 rastgele duruşta hata 0). Başlangıç kalibrasyonu ve "Sıfırla" butonu kaldırıldı, yanlış merkez oluşturup yön kaymasına yol açıyordu. Not: Formül portre tutuşu varsayar (telefon yatay tutulursa eksenler değişir).

## 8. Puan sistemi

Ekranda görünen skor, içteki skorun 1/10'udur. Önceden AWS logosu içte +50 yani ekranda +5 veriyordu, saniyede 6 olan zaman puanının altında kalıyordu ve görsel geri bildirim yoktu.

- AWS logosu artık ekranda +50 verir (`BASIC_POINTS = 50`, `js/monitor-game.js`). EC2 aktifken +100.
- Güçlendirici alınınca yüzen yazı çıkar: `+50`, `⚡ Yenilmez!`, `🪣 Kalkan!`, `🖥️ x2 Puan!`. Isınmada "Isınma: etkisiz".
- Skorlar eskisinden yüksek çıkacak. Etkinlikten önce DynamoDB tablosundaki eski/test kayıtlarını temizlemek adil bir sıralama için gerekir.

## 9. Araştırma özeti (kod değişmedi)

Kaynak bulunabilen noktalar:
- **Eğim kontrolü:** Düşük geçiren filtre, maksimum eğim sınırı ve hassasiyet çarpanı yaygın. [Game Developer](https://gamedeveloper.com/programming/using-the-accelerometer-in-games---part-2), [Unreal forumu](https://forums.unrealengine.com/t/tilt-steering/671612).
- **Sabit zaman adımı:** [Gaffer on Games, Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/).
- **Girdi tamponu:** Çok kısa bir dokunuşun kaçmaması için girdiyi kısa süre saklamak. [Smash Wiki, Buffering](https://www.ssbwiki.com/Buffering).
- **1€ Filtresi:** Yavaş harekette titremeyi bastırır, hızlı harekette gecikmeyi düşürür. [casiez/OneEuroFilter](https://github.com/casiez/OneEuroFilter).
- **AirConsole:** WebRTC destekli telefonlarda 1–10 ms, olmayanlarda 40–120 ms (2015 verisi). [TechCrunch](https://techcrunch.com/2015/10/23/airconsole/amp/).

Kaynaksız genel bilgi (doğrulanmadı): Subway Surfers gibi koşu oyunlarında şeritli hareket, zamanla hızlanma, çarpma sonrası kısa dokunulmazlık, ramak kala bonusu.

### AWS bölge ölçümü
Bu bilgisayardan TCP bağlantı süresi (6 deneme, en iyi → en kötü, ms): Frankfurt 64→275, Milano 58→125, Zürih 66→108, Tel Aviv 99→136, BAE 166→232. AWS IoT Core Milano, İspanya, Stockholm, Bahreyn, BAE ve Tel Aviv'de var, Zürih'te yok. Bölge değiştirmek en iyi ihtimalle 5–15 ms kazandırır. Türkiye'de AWS bölgesi veya Local Zone yok. API Gateway WebSocket ve AppSync Events için yayımlanmış bir gecikme kıyası bulunamadı.

### En büyük gecikme kazancı fikri
Telefon ile monitör aynı Wi-Fi'daysa mesajı buluttan geçirmemek: WebRTC veri kanalı (`ordered:false, maxRetransmits:0`). Eşleşme mesajları mevcut IoT MQTT hattından, STUN için `stun.kinesisvideo.<bölge>.amazonaws.com:443`. Doğrudan bağlantı kurulamazsa (istemci yalıtımı, mobil veri) mevcut MQTT yolu yedek kalır. Kinesis Video Streams JS SDK'sı veri kanalı API'si belgelemiyor, o yüzden doğrudan tarayıcının `RTCPeerConnection`'ı kullanılmalı. Henüz uygulanmadı.

## 10. Test yöntemleri

- **Playwright** (yerel, gerçek AWS'ye bağlı): ekran hızı `requestAnimationFrame` kaydırılarak simüle edildi; sensör için `deviceorientation` olayları (alpha/beta/gamma) üretildi; tuş için `pointerdown/up` gönderildi. DynamoDB testlerde bellek içi sahte depoyla değiştirildi (gerçek tabloya kayıt yazmamak için).
- **Yerel sunucu:** `python -m http.server 8000`, sonra `http://localhost:8000/Monitor.html`. `js/config.js` içine canlı sitedeki (`.../js/config.js`) gerçek değerler girilmeli (dosya `.gitignore`'da).
- **Telefonsuz kumanda testi:** Yerel monitördeki QR linkini ikinci Chrome penceresinde aç, F12 → Sensors → Orientation ile `beta`/`gamma` ayarla.
- **Gerçek telefon:** HTTPS gerekir (`DeviceOrientation` ve `crypto.subtle` için). Önerilen yol: `test` dalı ve Amplify'da o dalı bağlamak (bkz. bölüm 12).

## 11. Gizlilik ve hukuki not (hukuki tavsiye değildir)

Silinemeyen bir cihaz parmak izi tutmak KVKK kapsamında kişisel veri işleme sayılabilir (aydınlatma ve çoğu durumda açık rıza gerekir) ve kullanıcının "bu cihazı unut" kararını aşmak orantısız görülebilir. Bu yüzden yapılmadı. Yapılan: tarayıcıda saklanan rastgele kod (silinirse yenisi üretilir) ve telefon girişinde kısa bir bilgilendirme. Öneriler:
- Etkinlik bitince DynamoDB tablosunu temizleyin veya tabloda süre dolunca silme (TTL) ayarını AWS konsolundan açın.
- Ciddi bir ödül ve geniş kitle varsa bir aydınlatma metni hazırlatın.

## 12. Kalan işler ve bilinen riskler

Öncelik sırasıyla:

1. **Tuşa tek dokunuş:** Kısa dokunuş (50 ms örnekleme aralığından kısa) kaçabiliyor ve gönderilse bile bulutu neredeyse hiç oynatmıyor. Çözüm: en az ~120 ms'lik "dürtme" (input buffering) ve başlangıçta daha güçlü ilk hız.
2. **Sahte skor:** Cognito kimliksiz rolü DynamoDB'ye doğrudan yazabiliyor. Tarayıcı konsolundan herkes istediği skoru yazabilir. Ödül verilecekse birincinin gerçekliğini monitörden doğrulayın. Kalıcı çözüm: skoru bir Lambda/API Gateway arkasından yazmak ve rolü kısmak.
3. **Lambda güçlendirici yığılması:** 4 sn içinde ikinci Lambda alınırsa `oldSpeed` zaten artmış hızı saklar, hız kalıcı yükselir. (Henüz düzeltilmedi.)
4. **`endGame()` aynı karede birden çok kez çağrılabilir** (birden çok engel çarparsa) ve skoru iki kez yazabilir. (Henüz düzeltilmedi.)
5. **1€ filtresi:** Sabit EMA yerine, titremeyi ve gecikmeyi birlikte iyileştirmek için.
6. **WebRTC doğrudan kanal** (bölüm 9) ve MQTT yedeği.
7. **Oda sahipliği yok:** QR linkini alan ikinci telefon aynı odayı kontrol edebilir. İlk bağlanan oyuncu kilitlenebilir.
8. **Dış bağımlılıklar:** AWS SDK v2 (desteği sona eriyor) ve mqtt.js `unpkg` CDN'inden geliyor. Stant Wi-Fi'ı kesilirse oyun açılmaz. Yerel dosyaya alınması önerilir.
9. **Klavye:** Herhangi bir tuş oyunu başlatıyor ("Anonim" oyun açılır, skor kaydedilmez). Üretimde kapatılabilir.
10. **README:** DynamoDB anahtarını `PlayerID` diye anlatıyor, kod `SessionId` + `PlayerName` yazıyor. Düzeltilmeli.
11. **Etkinlik öncesi:** Oyun hızı test butonlarını gizleyin ve varsayılan hızı seçin, DynamoDB'deki test kayıtlarını temizleyin, gerçek telefonla ve stant Wi-Fi'ında deneyin (monitör bilgisayarını kabloyla bağlamak ve 5 GHz Wi-Fi kullanmak yardımcı olur).

## 13. Dosya haritası

| Dosya | Görev |
|---|---|
| `Monitor.html`, `js/monitor-game.js` | Oyun, çizim, dt tabanlı döngü, güçlendiriciler, hız test butonları |
| `js/monitor-mqtt.js` | MQTT bağlantısı, eğim eğrisi, oyuncu adı/cihaz kodu işleme |
| `js/monitor-aws.js` | Cognito, DynamoDB tarama/yazma, skor tabloları, `escapeHtml`, `scanAll` |
| `js/monitor-qr.js` | QR kod |
| `kumanda.html`, `js/kumanda-ui.js` | Telefon arayüzü, isim/hak kontrolü, öğretici, eğim açısı, yön tuşları, hassasiyet |
| `js/kumanda-aws.js` | Telefon tarafı AWS bağlantısı, doğrudan MQTT, gönderme, cihaz kodu |
| `js/iot-sign.js` | SigV4 imzalı MQTT WebSocket URL üretici (iki sayfa paylaşır) |
| `js/game-rules.js` | `MAX_ATTEMPTS`, `TESTER_NAMES` (iki sayfa paylaşır) |
| `css/monitor.css`, `css/kumanda.css` | Stiller |
| `js/config.js` | AWS değerleri (`.gitignore`'da; Amplify build sırasında ortam değişkenlerinden üretilir) |
| `amplify.yml` | Amplify build tarifi |

## 14. Ayarlanabilir değerler

| Değer | Yer | Varsayılan |
|---|---|---|
| Oyun hakkı | `js/game-rules.js` `MAX_ATTEMPTS` | 3 |
| Deneme isimleri | `js/game-rules.js` `TESTER_NAMES` | `['deneyici1234']` |
| AWS logosu puanı (ekran) | `js/monitor-game.js` `BASIC_POINTS` | 50 |
| Isınma süresi | `js/monitor-game.js` `WARMUP_MS` | 4000 |
| Monitör lerp | `js/monitor-game.js` | 0.25 (60 fps'te) |
| Telefon EMA | `js/kumanda-ui.js` `SENSOR_SMOOTH` | 0.25 (60 olay/sn'de) |
| Eğim eğrisi | `js/monitor-mqtt.js` `sensitivity`, `exponent` | 7.2, 1.12 |
| Hassasiyet çarpanları | `js/kumanda-ui.js` `SENS_LEVELS` | 0.7 / 1.0 / 1.3 |
| Tuş hızlanması | `js/kumanda-ui.js` `PAD_START`, `PAD_MAX`, `PAD_RAMP_MS` | 12°, 45°, 900 ms |
| Gönderme aralığı | `js/kumanda-aws.js` `SEND_INTERVAL_MS`, `HEARTBEAT_MS` | 33 ms, 250 ms |
| Sekme kapanma süresi | `js/kumanda-ui.js` `showGameOver` | 3 sn |
