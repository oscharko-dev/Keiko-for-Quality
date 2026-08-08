/* quality-glyphs.js — Keiko for Quality extension of the Lift icon system.
   Same grammar: 24×24 grid, stroke 1.6, round caps/joins, no fills, one open
   seam per closed contour. Use <span data-qicon="sevMajor" data-size="20"></span>. */
(function () {
  function P(d) { return '<path d="' + d + '"/>'; }
  var G = {
    /* severity — rank chevrons: count carries weight, colour carries urgency */
    sevCritical: P("M7 10.2 L12 5.2 L17 10.2") + P("M7 14.6 L12 9.6 L17 14.6") + P("M7 19 L12 14 L17 19"),
    sevMajor: P("M7 12.4 L12 7.4 L17 12.4") + P("M7 16.8 L12 11.8 L17 16.8"),
    sevMinor: P("M7 14.6 L12 9.6 L17 14.6"),
    sevNit: P("M12.94 8.94 A3.2 3.2 0 1 1 11.06 8.94") + P("M12 14.8 V16"),
    /* categories — monochrome, shape only */
    catSecurity: P("M11 3.7 L5 6 V11 c0 5 3.5 8.2 7 9.6 c3.5 -1.4 7 -4.6 7 -9.6 V6 L13 3.7"),
    catCorrectness: P("M8.5 9.2 C 8.5 6.9 10 6 12 6 C 14 6 15.5 6.9 15.5 9.2 V12.4 C 15.5 15.8 14 17.6 12 17.6 C 10 17.6 8.5 15.8 8.5 12.4 Z") + P("M9.7 7.2 L8.3 5.2 M14.3 7.2 L15.7 5.2") + P("M8.5 10.4 H5.4 M8.5 13.4 H5.4 M15.5 10.4 H18.6 M15.5 13.4 H18.6") + P("M12 8 V15.6"),
    catPerformance: P("M13 3 L5 13 h5 l-1 8 8 -10 h-5 z"),
    catMaintainability: P("M19.6 4.4 L13.4 10.6") + P("M13.4 10.6 C 11.6 9.4 9.2 9.6 7.8 11 L4.6 14.2 C 7 17.4 11.6 18.4 15 16.2 C 16.3 14.5 16.1 12.1 14.9 10.8") + P("M8.6 13.4 l2 2"),
    catTests: P("M9.5 4 V9.8 L5.2 17.6 a1.6 1.6 0 0 0 1.4 2.4 H17.4 a1.6 1.6 0 0 0 1.4 -2.4 L14.5 9.8 V4") + P("M8 4 H16") + P("M7.4 14 H16.6"),
    catDocs: P("M9 4.6 H13.4 L18 9.2 V18.5 a1 1 0 0 1 -1 1 H7 a1 1 0 0 1 -1 -1 V5.6 a1 1 0 0 1 1 -1 H7") + P("M13.4 4.6 V8.2 a1 1 0 0 0 1 1 H18") + P("M9 12.5 H15 M9 15.5 H13"),
    catReview: P("M12.94 6.4 A4.1 4.1 0 1 1 10.5 6.9") + P("M13.6 13.6 L18.8 18.8"),
    /* outcomes */
    outComplete: P("M20.3 12 A8.3 8.3 0 1 1 16 4.8") + P("M8.4 12.2 l2.6 2.6 L19 7"),
    outIncomplete: P("M12.85 6.2 L20 18.6 H4 L11.15 6.2") + P("M12 9.7 V13.7") + P("M12 16.2 h.01"),
    outAbandoned: P("M19.9 13.5 A8.2 8.2 0 1 1 13.6 4.05") + P("M12 7.4 V12 L15.4 13.8"),
    /* the reviewer itself */
    reviewBot: P("M5 7 H19 a0 0 0 0 1 0 0 V15 a3 3 0 0 1 -3 3 H8 a3 3 0 0 1 -3 -3 Z M5 7 a3 3 0 0 1 3 -3") + P("M12 4 V2.6") + P("M9.6 11.5 h.01 M14.4 11.5 h.01") + P("M9.8 14.6 H14.2"),
  };
  function svg(name, size) {
    size = size || 22;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (G[name] || "") + "</svg>";
  }
  function render(root) {
    (root || document).querySelectorAll("[data-qicon]").forEach(function (el) {
      if (el.dataset.qiconDone) return;
      el.innerHTML = svg(el.getAttribute("data-qicon"), parseInt(el.getAttribute("data-size") || "22", 10));
      el.dataset.qiconDone = "1";
    });
  }
  window.QualityGlyph = { svg: svg, render: render, names: Object.keys(G) };
  if (document.readyState !== "loading") render();
  else document.addEventListener("DOMContentLoaded", function () { render(); });
})();
