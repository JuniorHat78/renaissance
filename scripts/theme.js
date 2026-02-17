(function () {
  const STORAGE_KEY = "renaissance-theme";

  function normalizeTheme(input) {
    return input === "dark" ? "dark" : "light";
  }

  function writeTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      /* no-op: localStorage may be unavailable in restricted contexts */
    }
  }

  function readTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY));
    } catch (error) {
      return normalizeTheme(document.documentElement.getAttribute("data-theme"));
    }
  }

  function nextTheme(theme) {
    return theme === "dark" ? "light" : "dark";
  }

  function themeButtonLabel(currentTheme) {
    return currentTheme === "dark" ? "Light mode" : "Dark mode";
  }

  function initThemeToggle(buttonId) {
    const targetId = buttonId || "theme-toggle";
    const button = document.getElementById(targetId);
    if (!button) {
      return;
    }

    let currentTheme = readTheme();
    writeTheme(currentTheme);
    button.textContent = themeButtonLabel(currentTheme);

    button.addEventListener("click", () => {
      currentTheme = nextTheme(currentTheme);
      writeTheme(currentTheme);
      saveTheme(currentTheme);
      button.textContent = themeButtonLabel(currentTheme);
    });
  }

  window.RenaissanceTheme = {
    initThemeToggle
  };
})();
