// Applies a saved theme before the page paints, so there is no flash of the wrong theme.
(function () {
  try {
    var saved = localStorage.getItem('orbit-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage unavailable: keep the default dark theme */
  }
})();
