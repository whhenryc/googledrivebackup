// 通用card slider控制：撳左右箭嘴，滾動一張card嘅闊度
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-slider]').forEach(function (wrap) {
    const track = wrap.querySelector('.card-slider');
    const prevBtn = wrap.querySelector('[data-slider-prev]');
    const nextBtn = wrap.querySelector('[data-slider-next]');
    if (!track) return;

    function scrollByCard(dir) {
      const card = track.querySelector('.card, .slide-text');
      const gap = 24;
      const width = card ? card.getBoundingClientRect().width + gap : 300;
      track.scrollBy({ left: dir * width, behavior: 'smooth' });
    }

    if (prevBtn) prevBtn.addEventListener('click', () => scrollByCard(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => scrollByCard(1));
  });
});
