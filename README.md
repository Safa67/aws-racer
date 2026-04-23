# 🏎️ AWS Racer: Gerçek Zamanlı Bulut Yarışı

![AWS Racer Banner](images/Amazon_Web_Services_Logo.svg.png)

**AWS Racer**, AWS IoT Core'un gücünü sergileyen, tarayıcı tabanlı, gerçek zamanlı bir yarış oyunudur. Bu projede, bir bilgisayar ekranı **Oyun Monitörü** olarak çalışırken, herhangi bir akıllı telefon **Oyun Kumandasına** dönüşür. Aradaki iletişim, milisaniyeler seviyesinde gecikme ile AWS servisleri üzerinden sağlanır.

---

## ⚡ Temel Özellikler

- **📱 Akıllı Telefon Kumandası:** Herhangi bir uygulama yüklemeden, sadece QR kodu taratarak telefonunuzu bir oyun konsolu koluna dönüştürün.
- **☁️ AWS IoT Core Entegrasyonu:** MQTT protokolü ve WebSockets üzerinden ultra düşük gecikmeli veri iletimi.
- **🏆 Global Liderlik Tablosu:** Amazon DynamoDB entegrasyonu ile en yüksek skorlar anlık olarak kaydedilir ve sergilenir.
- **🛡️ Güvenli Kimlik Doğrulama:** Amazon Cognito ile unauthenticated rol yönetimi üzerinden güvenli kaynak erişimi.
- **🚀 Güçlendiriciler (AWS Power-ups):** 
    - **Lambda:** Geçici yenilmezlik ve hız artışı.
    - **S3:** Veri kalkanı (tek seferlik çarpma koruması).
    - **EC2:** İşlem gücü (süreli x2 puan çarpanı).
- **🚧 Engeller (Legacy Hardware):** Eski sunucular, disketler ve "Mavi Ekran" hataları üzerinden bulut bilişimin avantajlarını vurgulayan eğlenceli mekanikler.

---

## 🏗️ Mimari Yapı

Proje iki ana modülden oluşur:

1.  **Monitor (Ana Ekran - `Monitor.html`):** Oyunu render eder, skoru takip eder ve liderlik tablosunu yönetir.
2.  **Kumanda (Mobil Arayüz - `kumanda.html`):** Telefonun dokunmatik kontrollerini veya sensör verilerini alarak MQTT üzerinden ana ekrana komut gönderir.

### Teknoloji Yığını (Tech Stack)
- **Frontend:** Vanilla JavaScript, HTML5 Canvas, modern CSS.
- **Bulut Servisleri:**
    - **AWS IoT Core:** MQTT iletişimi için.
    - **Amazon DynamoDB:** Skor saklama.
    - **Amazon Cognito:** İzinler ve kimlik yönetimi.
    - **AWS Amplify:** Hızlı deployment ve host yönetimi.

---

## 🚀 Başlıyoruz

Lokalde çalıştırmak veya kendi AWS ortamınıza kurmak için şu adımları izleyin:

### 1. Dosya Yapısı
```text
.
├── Monitor.html        # Ana oyun ekranı
├── kumanda.html        # Mobil kontrolcü arayüzü
├── js/
│   ├── config.js       # AWS Yapılandırması (Kritik!)
│   ├── monitor-game.js # Oyun motoru ve mantığı
│   ├── monitor-mqtt.js # MQTT bağlantı yönetimi
│   └── ...
├── css/                # Tasarım dosyaları
└── amplify.yml         # CI/CD kurulumu
```

### 2. AWS Yapılandırması
`js/config.js` dosyasını açın ve kendi AWS değerlerinizi girin:

```javascript
const AWS_CONFIG = {
    region:        'eu-central-1',                 // AWS Bölgesi
    iotEndpoint:   'xxxx-ats.iot.eu-central-1...', // IoT Core Endpoint
    cognitoPoolId: 'eu-central-1:xxxx-xxxx',       // Identity Pool ID
    dynamoTable:   'AwsRacerScores',               // Tablo Adı
};
```

*Not: `config.js` dosyası güvenlik nedeniyle `.gitignore` listesindedir. Amplify üzerinde yayına alırken Environment Variables bölmesinden bu değerleri tanımlayabilirsiniz.*

---

## 🛠️ Kurulum Notları

- **IoT İzinleri:** Cognito Identity Pool ID için oluşturduğunuz Role'e `iot:Connect`, `iot:Subscribe`, `iot:Publish` ve `iot:Receive` izinlerini vermeyi unutmayın.
- **DynamoDB:** `PlayerID` (Partition Key) ve `Score` (Number) içeren bir tablo oluşturun.
- **CORS:** AWS IoT Core tarafında WebSocket için gerekli izinlerin (Custom Authorizer veya SigV4) ayarlandığından emin olun.

---

## 📈 Geliştirme

Bu proje, bir etkinlik/stent uygulaması olarak tasarlanmıştır. Geliştirme sürecinde şunlara dikkat edilmiştir:
- **EMA Filtresi:** Kontrolcü verileri, titremeyi önlemek için *Exponential Moving Average* ile yumuşatılmıştır.
- **Dinamik QR:** Her oturum için benzersiz bir `sessionID` üretilerek çakışma önlenir.

---

## 👨‍💻 Katkıda Bulunma
Her türlü öneri, hata bildirimi veya özellik talebi için lütfen bir **Issue** açın veya **Pull Request** gönderin.

---

**Made with ⚡ on AWS**
