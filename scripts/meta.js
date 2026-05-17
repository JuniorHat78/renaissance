(function () {
  function siteRootUrl() {
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      try {
        const url = new URL(canonical.href);
        url.search = "";
        url.hash = "";
        url.pathname = url.pathname.replace(/[^/]*$/, "");
        return url.toString();
      } catch (error) {
        // Fall through to runtime URL fallback.
      }
    }

    const fallback = new URL("./", window.location.href);
    fallback.search = "";
    fallback.hash = "";
    return fallback.toString();
  }

  const SITE_ROOT = siteRootUrl();

  function toAbsoluteUrl(relativePath) {
    return new URL(relativePath, SITE_ROOT).toString();
  }

  function canonicalEssayUrl(slug) {
    return toAbsoluteUrl("essay.html?essay=" + encodeURIComponent(slug));
  }

  function canonicalSectionUrl(slug, sectionNumber) {
    return toAbsoluteUrl(
      "section.html?essay=" + encodeURIComponent(slug) + "&section=" + String(sectionNumber)
    );
  }

  function setMetaByName(name, content) {
    const element = document.querySelector('meta[name="' + name + '"]');
    if (element) {
      element.setAttribute("content", content);
    }
  }

  function setMetaByProperty(property, content) {
    const element = document.querySelector('meta[property="' + property + '"]');
    if (element) {
      element.setAttribute("content", content);
    }
  }

  function setCanonical(url) {
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) {
      canonical.setAttribute("href", url);
    }
  }

  function socialImageForEssay(essay) {
    const explicit = String((essay && essay.social_image) || "").trim();
    if (explicit) {
      return explicit;
    }
    return "assets/og-home.png";
  }

  function setPageMetadata(metadata) {
    const title = String(metadata.title || "Renaissance");
    const description = String(metadata.description || "");
    const canonical = String(metadata.canonical || "");
    const image = String(metadata.image || "");

    document.title = title;
    if (canonical) {
      setCanonical(canonical);
      setMetaByProperty("og:url", canonical);
    }
    setMetaByName("description", description);
    setMetaByProperty("og:title", title);
    setMetaByProperty("og:description", description);
    setMetaByProperty("og:image", image);
    setMetaByName("twitter:title", title);
    setMetaByName("twitter:description", description);
    setMetaByName("twitter:image", image);
  }

  window.RenaissanceMeta = {
    canonicalEssayUrl,
    canonicalSectionUrl,
    setPageMetadata,
    socialImageForEssay,
    toAbsoluteUrl
  };
})();
