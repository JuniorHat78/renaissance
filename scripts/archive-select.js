(function () {
  const ENHANCED = "archiveSelectEnhanced";
  const SELECTOR = ".search-advanced select";
  let controlCount = 0;

  function optionLabel(option) {
    return option ? option.textContent.trim() : "";
  }

  function selectedOption(select) {
    return select.options[select.selectedIndex] || select.options[0] || null;
  }

  function labelForSelect(select) {
    const label = select.closest("label");
    if (!label) {
      return "";
    }
    const labelText = Array.from(label.children).find((child) => child.tagName === "SPAN");
    return labelText ? labelText.textContent.trim() : "";
  }

  function closeSelect(root) {
    const trigger = root.querySelector(".archive-select-button");
    const menu = root.querySelector(".archive-select-menu");
    root.dataset.open = "false";
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  }

  function closeOthers(activeRoot) {
    document.querySelectorAll(".archive-select[data-open='true']").forEach((root) => {
      if (root !== activeRoot) {
        closeSelect(root);
      }
    });
  }

  function syncSelect(select, root) {
    const value = root.querySelector(".archive-select-value");
    const trigger = root.querySelector(".archive-select-button");
    const menu = root.querySelector(".archive-select-menu");
    const current = selectedOption(select);
    const text = optionLabel(current);
    value.textContent = text;
    trigger.setAttribute("aria-label", root.dataset.label ? root.dataset.label + ": " + text : text);
    menu.replaceChildren(
      ...Array.from(select.options).map((option) => {
        const item = document.createElement("span");
        item.className = "archive-select-option";
        item.dataset.value = option.value;
        item.setAttribute("role", "option");
        item.setAttribute("tabindex", "-1");
        item.setAttribute("aria-selected", option === current ? "true" : "false");
        item.textContent = optionLabel(option);
        if (option.disabled) {
          item.setAttribute("aria-disabled", "true");
        }
        return item;
      })
    );
  }

  function focusCurrentOption(root) {
    const current =
      root.querySelector(".archive-select-option[aria-selected='true']") ||
      root.querySelector(".archive-select-option");
    if (current) {
      current.focus();
    }
  }

  function openSelect(root, shouldFocusOption) {
    const trigger = root.querySelector(".archive-select-button");
    const menu = root.querySelector(".archive-select-menu");
    closeOthers(root);
    root.dataset.open = "true";
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    if (shouldFocusOption) {
      focusCurrentOption(root);
    }
  }

  function chooseOption(select, root, item) {
    if (!item || item.getAttribute("aria-disabled") === "true") {
      return;
    }
    select.value = item.dataset.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncSelect(select, root);
    closeSelect(root);
    root.querySelector(".archive-select-button").focus();
  }

  function patchValue(select, sync) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (!descriptor || !descriptor.get || !descriptor.set || select.dataset.archiveValuePatched === "true") {
      return;
    }
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return descriptor.get.call(this);
      },
      set(nextValue) {
        descriptor.set.call(this, nextValue);
        queueMicrotask(sync);
      }
    });
    select.dataset.archiveValuePatched = "true";
  }

  function moveFocus(root, direction) {
    const options = Array.from(root.querySelectorAll(".archive-select-option"));
    if (options.length === 0) {
      return;
    }
    const currentIndex = Math.max(0, options.indexOf(document.activeElement));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    options[nextIndex].focus();
  }

  function enhanceSelect(select) {
    if (!select || select.dataset[ENHANCED] === "true") {
      return;
    }
    select.dataset[ENHANCED] = "true";
    select.classList.add("native-select-hidden");
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;

    const root = document.createElement("span");
    const trigger = document.createElement("span");
    const value = document.createElement("span");
    const menu = document.createElement("span");
    const idBase = select.id || "archive-select-" + String(++controlCount);

    root.className = "archive-select";
    root.dataset.open = "false";
    root.dataset.label = labelForSelect(select);
    trigger.id = idBase + "-visual";
    trigger.className = "archive-select-button";
    trigger.setAttribute("role", "button");
    trigger.setAttribute("tabindex", "0");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", idBase + "-menu");
    value.className = "archive-select-value";
    menu.id = idBase + "-menu";
    menu.className = "archive-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-labelledby", trigger.id);
    menu.hidden = true;

    trigger.appendChild(value);
    root.append(trigger, menu);
    select.insertAdjacentElement("afterend", root);

    const sync = () => syncSelect(select, root);
    patchValue(select, sync);
    sync();

    new MutationObserver(sync).observe(select, {
      attributes: true,
      attributeFilter: ["disabled", "label", "selected"],
      childList: true,
      subtree: true
    });

    select.addEventListener("change", sync);

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      if (root.dataset.open === "true") {
        closeSelect(root);
      } else {
        openSelect(root, false);
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        openSelect(root, true);
      }
      if (event.key === "Escape") {
        closeSelect(root);
      }
    });

    menu.addEventListener("click", (event) => {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : event.target.parentElement;
      chooseOption(select, root, target ? target.closest(".archive-select-option") : null);
    });

    menu.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(root, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(root, -1);
      } else if (event.key === "Home") {
        event.preventDefault();
        const first = root.querySelector(".archive-select-option");
        if (first) first.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        const options = root.querySelectorAll(".archive-select-option");
        const last = options[options.length - 1];
        if (last) last.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        chooseOption(select, root, document.activeElement);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeSelect(root);
        trigger.focus();
      }
    });

    root.addEventListener("focusout", () => {
      setTimeout(() => {
        if (!root.contains(document.activeElement)) {
          closeSelect(root);
        }
      }, 0);
    });
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll(SELECTOR).forEach(enhanceSelect);
  }

  document.addEventListener("click", (event) => {
    document.querySelectorAll(".archive-select[data-open='true']").forEach((root) => {
      if (!root.contains(event.target)) {
        closeSelect(root);
      }
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enhanceAll(document));
  } else {
    enhanceAll(document);
  }

  new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.matches && node.matches(SELECTOR)) {
            enhanceSelect(node);
          }
          enhanceAll(node);
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.RenaissanceSelects = { enhanceAll };
})();
