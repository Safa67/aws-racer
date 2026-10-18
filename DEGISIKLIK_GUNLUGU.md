# AWS Racer: Değişiklik Günlüğü ve Teknik Notlar

Bu dosya, projeyi gözden geçirme ve geliştirme oturumunda yapılan her şeyi, nedenlerini, ölçümleri, bilinçli olarak yapılmayanları ve kalan işleri tek yerde toplar. Son güncelleme: 18 Ekim 2026.

Canlı site (AWS Amplify, `main` dalı): `https://main.d308ipxr84hxtz.amplifyapp.com/Monitor.html`
Test sitesi (`test` dalı): `https://test.d308ipxr84hxtz.amplifyapp.com/`

## 1. Genel bakış

Oyun bir stant oyunudur. Monitördeki oyun (`Monitor.html`) bir QR kod gösterir. Oyuncu telefonuyla QR'ı okutur, `kumanda.html` açılır, telefonu eğerek (ya da ekrandaki ◀ ▶ tuşlarıyla) monitördeki bulutu yönlendirir. Haberleşme AWS IoT Core (MQTT), kimlik Amazon Cognito (kimliksiz rol), skorlar Amazon DynamoDB, barındırma AWS Amplify üzerindedir.

Proje AWS kulübü için yapıldığı için iki kısıt baştan geçerlidir: **AWS kredisi harcanması sınırlı tutulur** ve **bir oyuncunun ekranı uzun süre tek başına işgal etmesi istenmez**. Yapılan ve yapılmayan her şey bu iki kısıta göre değerlendirildi (bkz. bölüm 11).

## 2. Dallar ve commit listesi

### `main` (canlı site)

| Commit | Özet |
|---|---|
| `636595c` | Doğrudan MQTT, anlık "oyun bitti" sinyali, öğretici ekranı, ortak imzalama dosyası |
| `a374fab` | 3 haklı cihaz kodu, günlük skor tablosu, ısınma turu, yön tuşları, hassasiyet ayarı, XSS temizliği |
| `2b779b4` | Oyun başlamama riski, tuşlarda hızlanma, ısınmada etkisiz güçlendirici, eski kontrol hissine dönüş |
| `2093a78` | Oyun her ekran yenileme hızında aynı hızda çalışır |
| `5e136cb` | Telefon eğimi duruştan bağımsız, kalibrasyon kaldırıldı, `deneyici1234` hesabı |
| `6fafe13` | AWS logosu ekranda +50, yüzen puan yazıları, oyun hızı test butonları |

### `test` (test sitesi), `main`'in üstüne

| Commit | Durum | Özet |
|---|---|---|
| `f0d7b35` | push edildi | Bu günlük dosyası |
| `8d76867` | push edildi | Kök adres (`/`) `Monitor.html`'e yönlenir (önceden 404 veriyordu) |
| `ba00f6c` | **yerelde, push edilmedi** | Resmi oyun hızı 1.5x |
| `1e2b8a2` | **yerelde, push edilmedi** | Zorluk eğrisi, seri, ramak kala, dalga olayları, juice, ses, canlı sıra, tek kontrolcü kilidi, tarama azaltma |

Eski yerel (commit edilmemiş) değişiklikler `git stash` içinde `stash@{0}` olarak duruyor. İçinde bozuk bir regex vardı (bölüm 3). İhtiyaç yoksa `git stash drop` ile silinebilir.

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
- Monitör iki topic'e abone: eski shadow topic'i ve yeni `awsracer/<oda>/tilt`. Monitörden telefona giden bildirimler (`oyun bitti`, `oda dolu`) `awsracer/<oda>/state` üzerinden anında gider.
- İmzalama kodu `js/iot-sign.js` dosyasına taşındı. Hem monitör hem telefon kullanır.
- MQTT kopunca her denemede taze imzalı URL ile yeniden bağlanılır (`reconnectPeriod: 0` + `close` olayında kendi yeniden bağlanma). İmzalı URL eskiyince mqtt.js'in otomatik yeniden bağlanması başarısız olabiliyordu. Cognito süresi dolduysa imzalamadan önce yenilenir. `close` olayı `end()` ile tekrar tetiklenip çift bağlantı açabiliyordu, bir bayrakla engellendi.
- Gönderme aralığı 33 ms, aynı değer tekrar gönderilmez (250 ms heartbeat hariç), throttle'a takılan son değer kaybolmaz.
- Kullanılan IAM izinleri mevcut Cognito rolüyle yetti. AWS tarafında yeni izin gerekmedi.

### Kontrol hissi (geri alınan kısım)
Yumuşatmayı azaltmak (EMA 0.5, lerp 0.35) tepkiyi 117 ms'den 50 ms'ye indirdi ama kontrolü "sinirli" yaptı. Sonunda en baştaki değerlere dönüldü: telefon EMA 0.25, monitör lerp 0.25, eğri `açı^1.12 / 7.2`. Ölçülen ağ gecikmesi kazancı (doğrudan MQTT) korundu.

## 5. Kare hızından bağımsız oyun (144 Hz sorunu)

Sorun: Hareket, düşme hızı, skor ve yumuşatma "kare başına" hesaplanıyordu. 144 Hz ekranda oyun gerçek zamanda 2.4 kat hızlı akıyordu. Bu orijinal kodda da vardı.

Çözüm: Tüm hızlar "60 fps'te kare başına" ayarlı kalır. Her karede geçen süre referans kareye oranlanır (`dt = geçen_ms / 16.67`, en fazla 3). Hareket `* dt`, lerp katsayısı `1 - 0.75^dt`, skor zamanla artar. Telefon EMA'sı sensör olay hızından bağımsız hale getirildi (60/120/200 Hz sensör aynı sonuç). Büyük `dt` küçük fizik adımlarına bölünür, böylece çok hızlı nesneler çarpışmayı atlayamaz.

Ölçümler (ekran hızı tarayıcıda simüle edildi, 1.5x hızda):

| | Eski (kare başına), 144 Hz | Yeni, 30/60/144/240 Hz |
|---|---|---|
| Düşen engel (`baseSpeed` 3) | 2.4 kat hızlı | 275–276 px/sn (beklenen ~270) |
| İç skor artışı | 2.4 kat hızlı | 90/sn |

Gerçek bir 144 Hz ekranda ve gerçek telefonda henüz denenmedi.

### Oyun hızı: 1.5x
Resmi oyun hızı `DEFAULT_TIME_SCALE = 1.5` (`js/monitor-game.js`). Monitörün sol altındaki test butonları 1x / 1.5x (oyun) / 2.4x (144 Hz) arasında geçiş yaptırır. Seçim kaydedilmez, sayfa yenilenince 1.5x'e dönülür. Skor yalnızca 1.5x'te DynamoDB'ye yazılır. Etkinlikten önce butonlar gizlenmelidir.

## 6. Telefon eğimi: ters yön ve aşırı hassasiyet

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

## 7. Oyuncu tarafı kuralları ve arayüz

### Öğretici
İsim girişinden sonra tek ekranlık "Nasıl Oynanır?" gösterilir. Sensör başlatma ve iOS izin istemi "Hazırım, Başla" dokunuşuna bağlıdır. Oyuncu okurken monitördeki oyun başlamaz.

### Oyun başlamama riski
Telefonda sensör olayı gelmezse (telefon sabit, tarayıcı olay yollamıyor) monitör bekleme ekranında kalabilirdi. Artık "Hazırım"a basınca sensörden bağımsız bir sinyal ve ardından 300 ms'de bir "kalp atışı" gönderilir. Bu yüzden oyun her durumda başlar.

### Isınma turu
Oyun başında 4 saniye engel çıkmaz. Bu sürede ne zaman puanı ne de güçlendirici etkisi işler. Monitörde "ISINMA: puan ve güçlendiriciler geçerli değil" yazar. Isınmada alınan ödüller seriyi etkilemez.

### 3 hak ve cihaz kodu
- Telefon, tarayıcıda rastgele bir cihaz kodu (`awsracer_device`) saklar. Kişiyi tanımlamaz, silinirse yenisi üretilir. Bilinçli olarak parmak izi yapılmadı (KVKK riski, bkz. bölüm 12).
- Her cihaz toplam 3 oyun oynayabilir. İsim başka bir cihaza aitse alınamaz. Aynı cihaz hep aynı ismi kullanmak zorundadır. İsim kutusu önceki isimle otomatik dolar.
- DynamoDB kayıtlarına şu alanlar eklenir: `DeviceId`, `Day` (YYYY-MM-DD, monitör bilgisayarının yerel günü), `PlayedAt` (ms).
- Telefon, kendi cihaz kodunu her eğim mesajıyla monitöre gönderir. Skoru monitör yazar.

### Deneme hesabı
`js/game-rules.js` içinde `TESTER_NAMES = ['deneyici1234']`. Bu isimle her cihazdan sınırsız oynanır, hak ve isim sahipliği kontrolü yoktur. Skorlar kaydedilir ama monitör ve telefon skor tablolarında ve canlı sırada gösterilmez. Bu dosya herkese açık sunulduğu için isim gizli değildir.

### Tek kontrolcü (oda kilidi)
Bir QR'ı iki telefon aynı anda okutursa ya da oyun başladıktan sonra QR'ı başka biri okutursa:
- Odanın sahibi, **ilk kontrol mesajını (eğim ya da tuş) gönderen** telefondur. Eş zamanlı girişte monitör mesajları sıraya aldığı için tam bir kazanan çıkar (4 denemede 4/4 tutarlı).
- Diğer telefonların mesajları yok sayılır ve onlara "Bu oyunda başka bir oyuncu var" ekranı gösterilir. Oyun başladıktan sonra QR'ı okutan telefon isim ekranındayken bile hemen bu cevabı alır (telefon odaya katılınca bir `join` mesajı yollar).
- Oyuncu adı ve cihaz kodu yalnızca sahibinden alınır.
- Aynı telefondaki ikinci sekme reddedilmez (aynı cihaz kodu).
- "Oyun bitti" ekranı yalnızca odanın sahibine gösterilir. Başa dönünce yeni oda, kilitsiz başlar.
- Sahibi olan telefon bağlantısını kaybederse oda o oyun boyunca ona ait kalır (oyun zaten kısa sürede biter, sonra yeni QR çıkar).

### Monitör klavyesi
Klavye artık oyunu başlatmaz, hiçbir şey yapmaz. Yalnızca `Monitor.html?debug=1` ile: Enter oyunu başlatır, ← → oyuncuyu oynatır. Böylece standa yanlışlıkla basılan tuş "Anonim" bir oyun açmaz.

### Yön tuşları (isteğe bağlı)
Öğreticide "Eğmek yerine ekrandaki ◀ ▶ tuşlarıyla oyna" seçilirse iki büyük tuş çıkar. Sensör ve izin gerekmez. Basılı tutuldukça hız 12° eşdeğerinden 45°'ye 0.9 sn'de çıkar, bırakınca ya da yön değişince başa döner. Tuş basılı unutulmasın diye değer 50 ms'de bir tekrar gönderilir.

### Hassasiyet seçimi
Oyun ekranında Rahat / Normal / Hassas butonları (çarpan 0.7 / 1.0 / 1.3). Seçim tarayıcıda saklanır. Varsayılan Normal. Tuş modunda gizlenir.

### Diğer
- "Oyun bitti" ekranından sonra sekme 3 saniyede kapanmayı dener.
- Oyun bitince sensör ve tuş zamanlayıcıları durur.
- Oyuncu adları tablolara basılmadan önce HTML'den arındırılır (önceden `<img onerror=...>` gibi bir isim script çalıştırabilirdi).
- Tüm tablo taramaları `LastEvaluatedKey` ile sayfalanır (tek `scan` en fazla 1 MB döner, eski kod büyüyen tabloda eksik sonuç verebilirdi).

## 8. Oyun mekanikleri (monitör)

Tüm bu bölüm `js/monitor-game.js` (yeniden yazıldı) ve `js/monitor-fx.js` (yeni) içindedir. Dünya adımı ile çizim ayrıldı. Sabitler dosyanın başında toplandı (bölüm 14).

### Zorluk
- **Hız zamana bağlı, sürekli artar:** `hız çarpanı = 1 + 0.022 × oyun_saniyesi`. 30 sn → 1.66, 60 sn → 2.32, 90 sn → 2.98, 120 sn → 3.64. **Üst sınır yoktur.** Oyun beceriden bağımsız olarak kendiliğinden zorlaşır ve biter.
- **Bulgu:** Önceki sürümde hız artışı skor eşiğine (her 500 iç puan) bağlıydı. AWS logosu +50 yapıldığında bir logo tam bir hız basamağı oluyordu. Hız artık skordan bağımsız, yalnızca süreye bağlı.
- **Yakın doğma oranı:** Engellerin oyuncunun ±150 px yakınında doğma oranı %30'dan %70'e, 90 saniyede doğrusal çıkar.
- **Ödül hızı:** Ödüller, engel hız artışının yarısı kadar hızlanır (`√çarpan`), böylece yakalanabilir kalır.
- **Adil olma zorunluluğu yok** (kullanıcı tercihi): normal engeller rastgele doğar. Yalnızca dalga olayları geçilebilir üretilir (aşağıda).

### Ödüller
- AWS logosu şansı yarıya indirildi: %35 logo, %10'ar Lambda/S3/EC2 ve **%35 ihtimalle hiçbir şey çıkmaz** (güçlendiricilerin sıklığı değişmedi).
- AWS logosu ekranda +50 verir (`BASIC_POINTS`), içte x10 tutulur.
- **Lambda hatası düzeltildi:** Eski kod `speedMultiplier += 1.5` ve `oldSpeed` saklıyordu; 4 sn içinde ikinci Lambda alınırsa hız kalıcı yükseliyordu. Artık hız çarpanı `speedNow()` içinde anlık hesaplanır (süre × seri × Lambda 1.5x). Art arda alınınca yalnızca süre yenilenir.

### Seri çarpanı
- Her yakalanan ödül (logo veya güçlendirici) seriyi +1 yapar.
- **Seri bozulur:** bir ödül yakalanmadan ekranın altından çıkarsa, ya da S3 kalkanı bir çarpmayı emerse. (Logo Yağmuru'nda kaçırılan logolar ve ısınmadaki ödüller seriyi bozmaz.)
- Puan çarpanı basamakları: 3'te x1.5, 6'da x2, 10'da x3. EC2 aktifken +1 eklenir (**çarpanlar toplanır, çarpılmaz**).
- Seri başına oyun hızı +%3, en fazla +%25. Hız yumuşakça artar, seri bozulunca yavaşça (yaklaşık yarım saniyelik eğriyle) normale döner. Testte seri 10'da +%24.9 hız, bozulunca 4 sn içinde 1.00'a döndü.
- Ekranda üst ortada "🔥 SERİ xN" ve "puan xM" yazar. Basamak atlayınca "SERİ x2!" yazısı ve parçacık patlaması.

### Ramak kala
Engelin merkezi oyuncunun merkezini geçerken çarpışma sınırından en fazla 22 px uzaktan geçmişse: +10 puan, "Ramak kala! +10", kısa ekran sallanması ve ses. Aynı engel bir kez sayılır, iki bonus arasında 500 ms bekleme vardır (puan şişmesini sınırlar).

### Dönüm noktası
Ekran puanı 500, 1000, 1500, 2000'e, sonra her 1000'e ulaşınca konfeti, "🎉 N PUAN!" yazısı ve melodi.

### Canlı sıra ve ilk 3 geri bildirimi
- Sol üstte "GÜNÜN SIRASI: #4 / 12" puan arttıkça güncellenir. Sıralama bugünün (`Day`) oyuncu başına en iyi skorlarına göre hesaplanır. Oyuncunun kendi önceki kayıtları sayılmaz (oyun bitince yerine yenisi geçer). Deneme hesapları sayılmaz.
- Sıra ilk 3'e girince ekranda geri bildirim çıkar: "🥉 Günün 3.'sü oldun!", "🥈 …", "🏆 Günün 1.'si oldun!" (konfeti ve ses). İlk 3 dışında bir sıra atlayınca küçük "▲ Günün sırası: #N" yazısı çıkar.
- **Ek AWS maliyeti yok:** Hesap, monitörün zaten çektiği skor taramasının önbelleğini kullanır (açılışta ve her oyun sonunda). Telefona sıra bilgisi gönderilmez (ek IoT mesajı olmasın diye).

### Dalga olayları
Oyun saniyesine göre çalışır (ısınma sayılmaz). İlk dalga 20. saniyede, sonrakiler 22–32 sn arayla, Mavi Ekran ve Sunucu Duvarı sırayla. Her olayın başında uyarı bandı çıkar ("⚠ MAVİ EKRAN YAĞMURU!" gibi) ve ses çalar, yeni normal engel doğması durur.

- **Mavi Ekran Yağmuru** (11 adım, adım başına en fazla 2 engel): Olay başlamadan önce ekranın temizlenmesi beklenir. Oyuncunun o anki yerinden başlayan, adım başına en fazla 90 px kayan bir "güvenli koridor" belirlenir ve engeller bu koridorun (komşu adımlarla birleşik) bandının ±95 px dışına yerleştirilir. Böylece her zaman, oyuncunun yerinden başlayıp bant içinde kalarak geçebileceği bir yol vardır ve gereken yanal hız oyuncunun en yüksek hızının yaklaşık dörtte biridir.
- **Sunucu Duvarı** (2 duvar, 1.4 sn arayla): Ekranı kaplayan sunucu sırası, 3 kutu genişliğinde (≈150 px) bir boşlukla. Boşluk, oyuncunun o anki hızıyla ulaşabileceği mesafenin içinde seçilir (hız arttıkça mesafe daralır). İkinci duvarın boşluğu birincinin boşluğundan makul uzaklıkta seçilir.
- **Logo Yağmuru:** Oyun boyunca **yalnızca bir kez, 60. saniyede**: 14 AWS logosu ~4 sn'de yağar (yağmur sırasında normal engel çıkmaz). Bu olay çevresindeki ±10 sn'ye başka dalga konmaz.

Geçilebilirlik, bir **bot oyuncuyla** sınandı: Bot ekrana bakıp en güvenli yeri seçer ve oyuncunun gerçek hız sınırıyla hareket eder.
- Yalnız dalga (normal engel kapalı): hız çarpanı 2.2'den 4.7'ye kadar, Yağmur ve Duvar için 8 senaryo, her biri art arda 5 dalga: **8/8 hayatta**.
- Normal engeller açıkken karışık dalga dizisi: 4/4 hayatta.
- **Negatif kontrol:** koridor mantığı kapatılıp engeller rastgele konunca rastgele yağmurda bot 2/2 öldü, yani test gerçekten ayırt edici. (Rastgele duvar botu öldürmedi: bot mükemmel okuyup en hızlı hareket ediyor, duvar için asıl güvence ulaşılabilirlik sınırıdır.)
- Bot "mükemmel" oyuncudur; gerçek oyuncu daha yavaştır. Bu yüzden ulaşılabilirlik hesabı oyuncunun yanal hızının yalnızca %45'ini kullanır.

### Juice (geri bildirim)
- **Parçacıklar:** ödül alınca renkli patlama, kalkan kırılınca mavi patlama, çarpmada kırmızı, konfeti (dönüm noktası / ilk 3).
- **Ekran sallanması:** kalkan kırılması, ramak kala, dalga başlangıcı (dünya sallanır, yazılar sallanmaz).
- **Ses:** Tümü WebAudio ile tarayıcıda üretilir. Dosya, indirme ve AWS maliyeti yoktur. Efektler: ödül (seri arttıkça yükselen nota), güçlendirici, kalkan, ramak kala, seri bozulması, seri basamağı, dönüm noktası, sıra atlama, ilk 3, uyarı, dalga başlangıcı, logo yağmuru, çarpma.
- **Ses uyarısı:** Tarayıcılar kullanıcı etkileşimi olmadan ses çalmaz. Monitör bilgisayarında sayfaya **bir kez tıklamak (ya da bir tuşa basmak)** gerekir; düğme "🔊 Ses (tıkla)" yazar, açılınca "🔊 Ses açık" olur. Kiosk için Chrome `--autoplay-policy=no-user-gesture-required` ile açılabilir. Düğmeyle ses kapatılabilir.

## 9. Puan sistemi

Ekranda görünen skor, içteki skorun 1/10'udur. Zaman puanı 1.5x hızda saniyede 9 (ekran), AWS logosu +50, ramak kala +10, seri çarpanıyla katlanır. Skorlar eski sürümlere göre belirgin yükselecek. Etkinlikten önce DynamoDB tablosundaki eski/test kayıtlarını temizlemek adil bir sıralama için gereklidir.

## 10. Test yöntemleri

- **Playwright** (yerel, gerçek AWS IoT'ye bağlı): ekran hızı `requestAnimationFrame` kaydırılarak simüle edildi; sensör için `deviceorientation` olayları (alpha/beta/gamma) üretildi; tuş için `pointerdown/up` gönderildi; iki ayrı telefon oturumu (ayrı cihaz kodu) ile oda kilidi sınandı. DynamoDB testlerde bellek içi sahte depoyla değiştirildi (gerçek tabloya kayıt yazmamak için).
- **Bot oyuncu:** dalga geçilebilirliği için (bölüm 8).
- **Yerel sunucu:** `python -m http.server 8000`, sonra `http://localhost:8000/Monitor.html`. `js/config.js` içine canlı sitedeki (`.../js/config.js`) gerçek değerler girilmeli (dosya `.gitignore`'da).
- **Telefonsuz kumanda testi:** Yerel monitördeki QR linkini ikinci Chrome penceresinde aç, F12 → Sensors → Orientation ile `beta`/`gamma` ayarla.
- **Gerçek telefon:** HTTPS gerekir (`DeviceOrientation` ve `crypto.subtle` için). Yol: `test` dalı ve Amplify'da o dalı bağlamak. Test sitesi gerçek DynamoDB tablosunu kullanır; `deneyici1234` ismiyle oynayın.
- **Gerçek cihazda henüz denenmeyenler:** iPhone/Android'de eğim formülü, tuş modu, ses kilidi, gerçek 144 Hz ekran.

## 11. AWS kredisi ve ekran işgali: kararlar

Proje AWS kulübünün kredisiyle çalışır. Bu yüzden:

### Yeni AWS maliyeti getirmeyen ve yapılanlar
- Yeni mekanikler (zorluk, seri, ramak kala, dalga olayları, kutlamalar, juice, ses, canlı sıra) tamamen tarayıcıda çalışır. **Yeni AWS servisi ya da çağrısı eklenmedi.**
- Canlı sıra ek tarama yapmaz, önbellekten hesaplanır. Telefona sıra bilgisi gönderilmez (ek IoT mesajı olmasın diye).
- Ses WebAudio ile üretilir (S3/CloudFront'ta dosya yok).
- **Tasarruf:** Telefon skor tablosunu önceden her 10 saniyede bir tüm tabloyu tarayarak yeniliyordu. Artık yalnızca oyun başında bir kez çeker (ölçüm: isim kontrolünden sonraki 32 sn içinde ek tarama 0). "Oyun bitti" yedek yoklaması 3 sn yerine 10 sn'de bir (asıl sinyal MQTT ile anında gelir).
- Oyuncu gönderim sıklığı 33 ms (~30 mesaj/sn), değişmeyen değer tekrar gönderilmez.

### Ekran işgali
- **Toplam süre sınırı koyulmadı** (kullanıcı tercihi). Bunun yerine zorluk sınırsız artar (bölüm 8): hız sınırsız yükselir, yakın doğma %70'e çıkar, seri hızı artırır, dalga olayları gelir. Bu yüzden oyun beceriden bağımsız olarak kendiliğinden biter. Gerekirse sonradan kesin bir süre sınırı ya da "ani ölüm" eklenebilir.
- Oyun başına 3 hak sınırı zaten vardır (bölüm 7).
- Oda kilidi sayesinde ikinci bir telefon ekranı ele geçiremez.

### Bilinçli olarak yapılmayanlar
- **WebRTC doğrudan kanal, bölge değiştirme (Milano vb.), API Gateway/AppSync:** Gecikme/kredi kazancı sınırlı ya da ek karmaşıklık/maliyet getirdiği için uygulanmadı (bölüm 13'te araştırma özeti).
- **Skor yazımını Lambda/API Gateway arkasına taşımak (sahte skor çözümü):** Ek AWS kaynağı ve maliyeti gerektirdiği için yapılmadı. Ödül verilecekse birincinin gerçekliği monitörden doğrulanmalı.
- **Önerilen ama onaylanmayan/istenmeyenler:** can (kalp) sistemi, yeni güçlendiriciler (CloudFront, DynamoDB mıknatısı, Auto Scaling), AWS bilgi kartları, iki kişilik yarış, bekleme ekranı. Bunlar uygulanmadı.

## 12. Gizlilik ve hukuki not (hukuki tavsiye değildir)

Silinemeyen bir cihaz parmak izi tutmak KVKK kapsamında kişisel veri işleme sayılabilir (aydınlatma ve çoğu durumda açık rıza gerekir) ve kullanıcının "bu cihazı unut" kararını aşmak orantısız görülebilir. Bu yüzden yapılmadı. Yapılan: tarayıcıda saklanan rastgele kod (silinirse yenisi üretilir) ve telefon girişinde kısa bir bilgilendirme. Öneriler:
- Etkinlik bitince DynamoDB tablosunu temizleyin veya tabloda süre dolunca silme (TTL) ayarını AWS konsolundan açın.
- Ciddi bir ödül ve geniş kitle varsa bir aydınlatma metni hazırlatın.

## 13. Araştırma özeti (kod değişmedi)

Kaynak bulunabilen noktalar:
- **Eğim kontrolü:** Düşük geçiren filtre, maksimum eğim sınırı ve hassasiyet çarpanı yaygın. [Game Developer](https://gamedeveloper.com/programming/using-the-accelerometer-in-games---part-2), [Unreal forumu](https://forums.unrealengine.com/t/tilt-steering/671612).
- **Sabit zaman adımı:** [Gaffer on Games, Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/).
- **Girdi tamponu:** Çok kısa bir dokunuşun kaçmaması için girdiyi kısa süre saklamak. [Smash Wiki, Buffering](https://www.ssbwiki.com/Buffering).
- **1€ Filtresi:** Yavaş harekette titremeyi bastırır, hızlı harekette gecikmeyi düşürür. [casiez/OneEuroFilter](https://github.com/casiez/OneEuroFilter).
- **AirConsole:** WebRTC destekli telefonlarda 1–10 ms, olmayanlarda 40–120 ms (2015 verisi). [TechCrunch](https://techcrunch.com/2015/10/23/airconsole/amp/).
- **Zorluk eğrisi:** Chrome Dino hızı 6'dan 13'e (2.17 kat) kare başına +0.001 ile ~117 saniyede çıkar ve sınırlıdır; engel boşluğu hızla orantılıdır, ilk 3 saniye engel yoktur. [Chromium T-Rex runner kaynak kodu](https://raw.githubusercontent.com/wayou/t-rex-runner/gh-pages/index.js). Ortalama görsel tepki süresi yaklaşık 250 ms. Zorluk ayarı ölçülü yapılmalı (lastik bant etkisi): [Wikipedia](https://en.wikipedia.org/wiki/Dynamic_game_difficulty_balancing).
- **Juice:** Parçacık, ekran sallanması (50–300 ms), yüzen yazı ve ses bir oyunu belirgin şekilde daha eğlenceli yapar. [özet](https://eastondev.com/blog/en/posts/dev/20260521-game-feedback-feel/), [kaynak](https://rpgplayground.com/research-making-a-juicy-game/).

Kaynaksız genel bilgi (doğrulanmadı): koşu oyunlarında şeritli hareket, çarpma sonrası dokunulmazlık, ramak kala bonusu.

### AWS bölge ölçümü
Bu bilgisayardan TCP bağlantı süresi (6 deneme, en iyi → en kötü, ms): Frankfurt 64→275, Milano 58→125, Zürih 66→108, Tel Aviv 99→136, BAE 166→232. AWS IoT Core Milano, İspanya, Stockholm, Bahreyn, BAE ve Tel Aviv'de var, Zürih'te yok. Bölge değiştirmek en iyi ihtimalle 5–15 ms kazandırır. Türkiye'de AWS bölgesi veya Local Zone yok. API Gateway WebSocket ve AppSync Events için yayımlanmış bir gecikme kıyası bulunamadı.

### En büyük gecikme kazancı fikri (uygulanmadı)
Telefon ile monitör aynı Wi-Fi'daysa mesajı buluttan geçirmemek: WebRTC veri kanalı (`ordered:false, maxRetransmits:0`). Eşleşme mesajları mevcut IoT MQTT hattından, STUN için `stun.kinesisvideo.<bölge>.amazonaws.com:443`. Doğrudan bağlantı kurulamazsa (istemci yalıtımı, mobil veri) mevcut MQTT yolu yedek kalır. Kinesis Video Streams JS SDK'sı veri kanalı API'si belgelemiyor, o yüzden doğrudan tarayıcının `RTCPeerConnection`'ı kullanılmalı.

## 14. Kalan işler ve bilinen riskler

Öncelik sırasıyla:

1. **Tuşa tek dokunuş:** Kısa dokunuş (50 ms örnekleme aralığından kısa) kaçabiliyor ve gönderilse bile bulutu neredeyse hiç oynatmıyor. Çözüm: en az ~120 ms'lik "dürtme" (input buffering) ve başlangıçta daha güçlü ilk hız.
2. **Sahte skor:** Cognito kimliksiz rolü DynamoDB'ye doğrudan yazabiliyor. Tarayıcı konsolundan herkes istediği skoru yazabilir. Ödül verilecekse birincinin gerçekliğini monitörden doğrulayın. Kalıcı çözüm (Lambda/API Gateway) ek AWS maliyeti getirir, bu yüzden bilinçli ertelendi.
3. **1€ filtresi:** Sabit EMA yerine, titremeyi ve gecikmeyi birlikte iyileştirmek için.
4. **Dış bağımlılıklar:** AWS SDK v2 (desteği sona eriyor) ve mqtt.js `unpkg` CDN'inden geliyor. Stant Wi-Fi'ı kesilirse oyun açılmaz. Yerel dosyaya alınması önerilir.
5. **README:** DynamoDB anahtarını `PlayerID` diye anlatıyor, kod `SessionId` + `PlayerName` yazıyor. Düzeltilmeli.
6. **Gerçek cihaz testleri:** bölüm 10'daki "denenmeyenler".
7. **Etkinlik öncesi kontrol listesi:**
   - Oyun hızı test butonlarını gizleyin (varsayılan zaten 1.5x).
   - DynamoDB'deki test/eski kayıtları temizleyin (skorlar yükseldi).
   - Monitör bilgisayarında sayfaya bir kez tıklayarak sesi açın (ya da Chrome'u autoplay bayrağıyla başlatın).
   - Monitör bilgisayarını kabloyla bağlayın, 5 GHz Wi-Fi kullanın, stant Wi-Fi'ında gerçek telefonla deneyin.
   - `test` dalındaki değişiklikleri beğenirseniz `main`'e birleştirin: `git checkout main`, `git merge test`, `git push origin main`.

Çözülenler (bu oturumda): Lambda hız yığılması, `endGame` çift çağrısı, klavyenin oyunu başlatması, oda sahipliği (ikinci telefon), telefon tablo taraması maliyeti.

## 15. Dosya haritası

| Dosya | Görev |
|---|---|
| `Monitor.html`, `js/monitor-game.js` | Oyun, çizim, dt tabanlı döngü, zorluk, seri, dalgalar, kutlamalar, canlı sıra, hız test butonları |
| `js/monitor-fx.js` | Parçacıklar, ekran sallanması, WebAudio ses efektleri |
| `js/monitor-mqtt.js` | MQTT bağlantısı, eğim eğrisi, oda kilidi, oyuncu adı/cihaz kodu işleme |
| `js/monitor-aws.js` | Cognito, DynamoDB tarama/yazma, skor tabloları, günün sırası önbelleği, `escapeHtml`, `scanAll` |
| `js/monitor-qr.js` | QR kod |
| `kumanda.html`, `js/kumanda-ui.js` | Telefon arayüzü, isim/hak kontrolü, öğretici, eğim açısı, yön tuşları, hassasiyet, "oda dolu" ekranı |
| `js/kumanda-aws.js` | Telefon tarafı AWS bağlantısı, doğrudan MQTT, `join` mesajı, gönderme, cihaz kodu |
| `js/iot-sign.js` | SigV4 imzalı MQTT WebSocket URL üretici (iki sayfa paylaşır) |
| `js/game-rules.js` | `MAX_ATTEMPTS`, `TESTER_NAMES` (iki sayfa paylaşır) |
| `index.html` | Kök adresi `Monitor.html`'e yönlendirir (`test` dalında) |
| `css/monitor.css`, `css/kumanda.css` | Stiller |
| `js/config.js` | AWS değerleri (`.gitignore`'da; Amplify build sırasında ortam değişkenlerinden üretilir) |
| `amplify.yml` | Amplify build tarifi |

## 16. Ayarlanabilir değerler

| Değer | Yer | Varsayılan |
|---|---|---|
| Oyun hızı çarpanı | `js/monitor-game.js` `DEFAULT_TIME_SCALE` | 1.5 |
| Hız artışı (saniye başına) | `js/monitor-game.js` `RAMP_PER_SEC` | 0.022 |
| Yakın doğma oranı | `NEAR_RATIO_START` / `NEAR_RATIO_END` / `NEAR_RATIO_RAMP_SEC` | %30 → %70, 90 sn |
| "Ödül çıkmaz" payı | `NOTHING_CHANCE` | %35 |
| Ödül ağırlıkları | `itemTypes[].chance` | logo 35, diğerleri 10 |
| AWS logosu puanı (ekran) | `BASIC_POINTS` | 50 |
| Isınma süresi | `WARMUP_MS` | 4000 |
| Seri basamakları | `STREAK_TIERS` | 3→x1.5, 6→x2, 10→x3 |
| Seri hız etkisi | `STREAK_SPEED_PER` / `STREAK_SPEED_MAX` | %3 / %25 |
| Lambda hız çarpanı | `LAMBDA_SPEED` | 1.5 |
| Ramak kala | `NEAR_MISS_PX` / `NEAR_MISS_POINTS` / `NEAR_MISS_COOLDOWN` | 22 px / 10 / 500 ms |
| Dalga zamanları | `WAVE_FIRST_AT` / `WAVE_GAP_MIN` / `WAVE_GAP_MAX` / `LOGO_RAIN_AT` | 20 / 22 / 32 / 60 sn |
| Yağmur/duvar/logo ayarları | `RAIN_*`, `WALL_*`, `LOGO_*` | bkz. dosya |
| Geçilebilirlik güvenliği | `REACH_FACTOR` | 0.45 |
| Oyun hakkı | `js/game-rules.js` `MAX_ATTEMPTS` | 3 |
| Deneme isimleri | `js/game-rules.js` `TESTER_NAMES` | `['deneyici1234']` |
| Monitör lerp | `js/monitor-game.js` | 0.25 (60 fps'te) |
| Telefon EMA | `js/kumanda-ui.js` `SENSOR_SMOOTH` | 0.25 (60 olay/sn'de) |
| Eğim eğrisi | `js/monitor-mqtt.js` `sensitivity`, `exponent` | 7.2, 1.12 |
| Hassasiyet çarpanları | `js/kumanda-ui.js` `SENS_LEVELS` | 0.7 / 1.0 / 1.3 |
| Tuş hızlanması | `js/kumanda-ui.js` `PAD_START`, `PAD_MAX`, `PAD_RAMP_MS` | 12°, 45°, 900 ms |
| Gönderme aralığı | `js/kumanda-aws.js` `SEND_INTERVAL_MS`, `HEARTBEAT_MS` | 33 ms, 250 ms |
| Sekme kapanma süresi | `js/kumanda-ui.js` `showGameOver` | 3 sn |
