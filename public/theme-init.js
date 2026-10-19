// Runs before the page paints: applies the saved theme (no flash of the wrong theme)
// and marks the page as embedded when it is shown inside another site's iframe.
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem('iam-bot-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage unavailable: keep the default dark theme */
  }
  if (window.parent !== window) root.classList.add('is-embedded');
})();
