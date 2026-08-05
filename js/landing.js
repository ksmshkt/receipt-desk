// Tap/click a screenshot to view it full-size (reuses app.html's lightbox pattern/styles).
document.querySelectorAll('.lp-screenshot-card img').forEach(img => {
  img.addEventListener('click', () => {
    document.getElementById('lightbox-image').src = img.src;
    document.getElementById('image-lightbox').classList.remove('hidden');
  });
});

document.getElementById('image-lightbox').addEventListener('click', () => {
  document.getElementById('image-lightbox').classList.add('hidden');
  document.getElementById('lightbox-image').src = '';
});
