(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssays } = window.RenaissanceContent;

  const essayList = document.getElementById("essay-list");

  function escapeHtml(text) {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function essayLink(slug) {
    return "essay.html?essay=" + encodeURIComponent(slug);
  }

  function renderEssays(essays) {
    if (!essays.length) {
      essayList.innerHTML = '<li class="muted">No essays published yet.</li>';
      return;
    }

    essayList.innerHTML = essays
      .map((essay) => {
        const sectionCount = essay.section_order.length;
        const sectionCopy = sectionCount === 1 ? "1 section" : String(sectionCount) + " sections";
        return (
          '<li class="essay-item">' +
            '<a href="' + essayLink(essay.slug) + '">' +
              '<h3 class="essay-title">' + escapeHtml(essay.title) + "</h3>" +
              '<p class="essay-summary">' + escapeHtml(essay.summary || "") + "</p>" +
              '<p class="essay-meta">' + escapeHtml(sectionCopy) + "</p>" +
            "</a>" +
          "</li>"
        );
      })
      .join("");
  }

  async function init() {
    initThemeToggle();

    try {
      const essays = await loadEssays();
      const published = essays.filter((essay) => essay.published !== false);
      renderEssays(published);
    } catch (error) {
      essayList.innerHTML = '<li class="muted">Unable to load essays.</li>';
    }
  }

  init();
})();
