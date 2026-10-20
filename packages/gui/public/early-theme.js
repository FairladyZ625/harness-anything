/* global localStorage, window, document */
(function () {
  try {
    var stored = localStorage.getItem("harness-theme");
    var isLight =
      stored === "light" ||
      (stored === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    var root = document.documentElement;
    if (isLight) {
      root.dataset.theme = "light";
      root.classList.remove("dark");
    } else {
      root.dataset.theme = "dark";
      root.classList.add("dark");
    }
  } catch (err) {
    void err;
  }
})();
