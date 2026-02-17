(function () {
  const { initThemeToggle } = window.RenaissanceTheme;
  const { loadEssay, loadEssays, loadSection, renderBlocks, sectionDisplay } = window.RenaissanceContent;

  const backToEssay = document.getElementById("back-to-essay");
  const essayLine = document.getElementById("essay-line");
  const sectionKicker = document.getElementById("section-kicker");
  const sectionTitle = document.getElementById("section-title");
  const sectionSubtitle = document.getElementById("section-subtitle");
  const sectionContent = document.getElementById("section-content");
  const prevLink = document.getElementById("prev-link");
  const nextLink = document.getElementById("next-link");
  const nextCta = document.getElementById("next-cta");

  function essayUrl(slug) {
    return "essay.html?essay=" + encodeURIComponent(slug);
  }

  function sectionUrl(slug, sectionNumber) {
    return "section.html?essay=" + encodeURIComponent(slug) + "&section=" + String(sectionNumber);
  }

  function setLink(link, url, label) {
    if (!url) {
      link.classList.add("hidden");
      link.removeAttribute("href");
      return;
    }

    link.classList.remove("hidden");
    link.href = url;
    link.textContent = label;
  }

  function queryEssaySlug() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("essay");
    return value ? value.trim() : "";
  }

  function querySectionNumber() {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("section");
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  async function resolveEssaySlug() {
    const explicit = queryEssaySlug();
    if (explicit) {
      return explicit;
    }

    const essays = await loadEssays();
    if (!essays.length) {
      throw new Error("No essays available");
    }
    return essays[0].slug;
  }

  function showMessage(message) {
    essayLine.textContent = "Renaissance";
    sectionKicker.textContent = "Reader";
    sectionTitle.textContent = message;
    sectionSubtitle.textContent = "";
    sectionContent.innerHTML = '<p><a href="index.html">Return to Home</a></p>';
    backToEssay.href = "index.html";
    backToEssay.textContent = "Home";
    setLink(prevLink, null, "");
    setLink(nextLink, null, "");
    setLink(nextCta, null, "");
  }

  async function init() {
    initThemeToggle();

    try {
      const essaySlug = await resolveEssaySlug();
      const essay = await loadEssay(essaySlug);
      if (!essay) {
        showMessage("Essay not found.");
        return;
      }

      if (!essay.section_order.length) {
        showMessage("No sections are available.");
        return;
      }

      const sectionNumber = querySectionNumber() || essay.section_order[0];
      if (!essay.section_order.includes(sectionNumber)) {
        showMessage("Section not found.");
        return;
      }

      const payload = await loadSection(essay.slug, sectionNumber);
      const display = sectionDisplay(essay, sectionNumber);
      const blocks = payload.contentBlocks.length ? payload.contentBlocks : payload.blocks;

      backToEssay.href = essayUrl(essay.slug);
      essayLine.textContent = essay.title;
      sectionKicker.textContent = display.label;
      sectionTitle.textContent = display.title;
      sectionSubtitle.textContent = display.subtitle ? "(" + display.subtitle + ")" : "";
      renderBlocks(sectionContent, blocks);
      document.title = display.title + " | " + essay.title + " | Renaissance";

      const currentIndex = essay.section_order.indexOf(sectionNumber);
      const previous = essay.section_order[currentIndex - 1];
      const next = essay.section_order[currentIndex + 1];

      setLink(prevLink, previous ? sectionUrl(essay.slug, previous) : null, "Previous Section");
      setLink(nextLink, next ? sectionUrl(essay.slug, next) : null, "Next Section");
      setLink(nextCta, next ? sectionUrl(essay.slug, next) : null, "Next Section");
    } catch (error) {
      showMessage("Unable to load this section.");
    }
  }

  init();
})();
