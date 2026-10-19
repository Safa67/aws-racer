/**
 * theme.js — Açık/koyu tema değiştirici (Monitor.html ve kumanda.html ortak)
 *
 * Önceden her sayfanın <head> içinde satır içi <script> ve düğmede satır içi onclick olarak
 * duruyordu. Satır içi script ve olay işleyicileri, sıkı bir Content-Security-Policy
 * (script-src'de 'unsafe-inline' olmadan) altında çalışmaz; bu dosya o yüzden dışarı taşındı.
 *
 * Düğmenin metni sayfadan sayfaya farklı (Monitor: "Dark Mode" / kumanda: "Dark"), bu yüzden
 * HTML'deki data-light-label / data-dark-label özniteliklerinden okunur.
 */
function toggleTheme() {
    document.body.classList.toggle('dark-theme');
    const isDark = document.body.classList.contains('dark-theme');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    applyThemeButton(isDark);
}

function applyThemeButton(isDark) {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.innerText        = isDark ? btn.dataset.lightLabel : btn.dataset.darkLabel;
    btn.style.background = isDark ? '#FFFFFF' : '#232F3E';
    btn.style.color      = isDark ? '#232F3E' : 'white';
}

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.addEventListener('click', toggleTheme);

    // Sayfa yüklendiğinde eski tercihe bak
    if (localStorage.getItem('theme') === 'dark') {
        document.body.classList.add('dark-theme');
        applyThemeButton(true);
    }
});
