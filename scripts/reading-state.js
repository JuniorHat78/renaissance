(function () {
  const STORAGE_KEY = "renaissance-reading-state:v1";
  const VERSION = 1;
  const COMPLETE_THRESHOLD = 0.92;
  const MIN_MEANINGFUL_PROGRESS = 0.04;
  const MIN_RESTORE_PROGRESS = 0.03;
  const MAX_RESTORE_PROGRESS = 0.9;

  function emptyState() {
    return {
      version: VERSION,
      last: null,
      essays: {}
    };
  }

  function storageAvailable() {
    return typeof window === "object" && typeof window.localStorage === "object";
  }

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.min(max, Math.max(min, number));
  }

  function normalizeSlug(value) {
    return String(value || "").trim();
  }

  function normalizeSectionNumber(value) {
    const sectionNumber = Number.parseInt(value, 10);
    return Number.isFinite(sectionNumber) && sectionNumber > 0 ? sectionNumber : null;
  }

  function normalizePositiveInteger(value) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function normalizeRatio(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, 0, 1) : null;
  }

  function sectionKey(sectionNumber) {
    return String(sectionNumber);
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const essaySlug = normalizeSlug(raw.essaySlug);
    const sectionNumber = normalizeSectionNumber(raw.sectionNumber);
    if (!essaySlug || sectionNumber === null) {
      return null;
    }

    const progress = clamp(raw.progress, 0, 1);
    const maxProgress = Math.max(progress, clamp(raw.maxProgress, 0, 1));
    const completed = Boolean(raw.completed) || maxProgress >= COMPLETE_THRESHOLD;
    const scrollY = Math.max(0, Number(raw.scrollY) || 0);
    const updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
    const resumeParagraphIndex = normalizePositiveInteger(raw.resumeParagraphIndex);
    const resumeParagraphRatio = normalizeRatio(raw.resumeParagraphRatio);

    return {
      essaySlug,
      sectionNumber,
      progress,
      maxProgress,
      scrollY,
      completed,
      updatedAt,
      resumeParagraphIndex,
      resumeParagraphRatio,
      essayTitle: String(raw.essayTitle || "").trim(),
      sectionTitle: String(raw.sectionTitle || "").trim(),
      sectionLabel: String(raw.sectionLabel || "").trim()
    };
  }

  function normalizeState(raw) {
    const normalized = emptyState();
    if (!raw || typeof raw !== "object") {
      return normalized;
    }

    const essays = raw.essays && typeof raw.essays === "object" ? raw.essays : {};
    Object.entries(essays).forEach(([essaySlug, sectionMap]) => {
      const cleanSlug = normalizeSlug(essaySlug);
      if (!cleanSlug || !sectionMap || typeof sectionMap !== "object") {
        return;
      }

      Object.entries(sectionMap).forEach(([sectionNumber, record]) => {
        const cleanRecord = normalizeRecord({
          ...record,
          essaySlug: cleanSlug,
          sectionNumber
        });
        if (!cleanRecord) {
          return;
        }

        if (!normalized.essays[cleanSlug]) {
          normalized.essays[cleanSlug] = {};
        }
        normalized.essays[cleanSlug][sectionKey(cleanRecord.sectionNumber)] = cleanRecord;
      });
    });

    normalized.last = normalizeRecord(raw.last);
    return normalized;
  }

  function readState() {
    if (!storageAvailable()) {
      return emptyState();
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return normalizeState(raw ? JSON.parse(raw) : null);
    } catch (error) {
      return emptyState();
    }
  }

  function writeState(state) {
    if (!storageAvailable()) {
      return false;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      return false;
    }
  }

  function getSectionRecord(essaySlug, sectionNumber) {
    const slug = normalizeSlug(essaySlug);
    const number = normalizeSectionNumber(sectionNumber);
    if (!slug || number === null) {
      return null;
    }

    const state = readState();
    const essayMap = state.essays[slug];
    return essayMap ? normalizeRecord(essayMap[sectionKey(number)]) : null;
  }

  function getLastRecord() {
    return normalizeRecord(readState().last);
  }

  function saveSectionProgress(payload) {
    const source = payload || {};
    const essaySlug = normalizeSlug(source.essaySlug);
    const sectionNumber = normalizeSectionNumber(source.sectionNumber);
    if (!essaySlug || sectionNumber === null) {
      return null;
    }

    const state = readState();
    const key = sectionKey(sectionNumber);
    const essayMap = state.essays[essaySlug] || {};
    const previous = normalizeRecord(essayMap[key]);
    const progress = clamp(source.progress, 0, 1);
    const maxProgress = Math.max(progress, previous ? previous.maxProgress : 0);
    const completed = maxProgress >= COMPLETE_THRESHOLD;
    const updatedAt = Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now();
    const resumeParagraphIndex = normalizePositiveInteger(source.resumeParagraphIndex) ||
      (previous ? previous.resumeParagraphIndex : null);
    const resumeParagraphRatio = normalizeRatio(source.resumeParagraphRatio);
    const resolvedResumeParagraphRatio = resumeParagraphRatio !== null
      ? resumeParagraphRatio
      : previous ? previous.resumeParagraphRatio : null;

    const record = {
      essaySlug,
      sectionNumber,
      progress,
      maxProgress,
      scrollY: Math.max(0, Number(source.scrollY) || 0),
      completed,
      updatedAt,
      resumeParagraphIndex,
      resumeParagraphRatio: resolvedResumeParagraphRatio,
      essayTitle: String(source.essayTitle || (previous && previous.essayTitle) || "").trim(),
      sectionTitle: String(source.sectionTitle || (previous && previous.sectionTitle) || "").trim(),
      sectionLabel: String(source.sectionLabel || (previous && previous.sectionLabel) || "").trim()
    };

    essayMap[key] = record;
    state.essays[essaySlug] = essayMap;
    state.last = record;
    writeState(state);
    return record;
  }

  function shouldRestore(record) {
    const normalized = normalizeRecord(record);
    if (!normalized || normalized.completed) {
      return false;
    }

    return (
      normalized.progress >= MIN_RESTORE_PROGRESS &&
      normalized.progress <= MAX_RESTORE_PROGRESS &&
      (normalized.scrollY > 80 || normalized.resumeParagraphIndex !== null)
    );
  }

  function isMeaningful(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) {
      return false;
    }
    return normalized.completed || normalized.maxProgress >= MIN_MEANINGFUL_PROGRESS || normalized.scrollY > 120;
  }

  function sectionUrl(essaySlug, sectionNumber) {
    return "section.html?essay=" + encodeURIComponent(essaySlug) + "&section=" + String(sectionNumber);
  }

  function continueTarget(essays, contentApi) {
    const last = getLastRecord();
    if (!isMeaningful(last) || !Array.isArray(essays)) {
      return null;
    }

    const essay = essays.find((entry) => entry && entry.slug === last.essaySlug);
    if (!essay || !Array.isArray(essay.section_order) || essay.section_order.length === 0) {
      return null;
    }

    const currentIndex = essay.section_order.indexOf(last.sectionNumber);
    if (currentIndex === -1) {
      return null;
    }

    const nextSection = essay.section_order[currentIndex + 1];
    if (last.completed && !Number.isFinite(nextSection)) {
      return null;
    }

    const shouldAdvance = last.completed && Number.isFinite(nextSection);
    const targetSectionNumber = shouldAdvance ? nextSection : last.sectionNumber;
    const sectionDisplay = contentApi && typeof contentApi.sectionDisplay === "function"
      ? contentApi.sectionDisplay(essay, targetSectionNumber)
      : {
          label: "Section " + String(targetSectionNumber),
          title: last.sectionTitle || "Section " + String(targetSectionNumber)
        };

    return {
      essay,
      last,
      sectionNumber: targetSectionNumber,
      href: sectionUrl(essay.slug, targetSectionNumber),
      action: shouldAdvance ? "next" : "continue",
      progress: last.progress,
      maxProgress: last.maxProgress,
      completed: last.completed,
      sectionLabel: sectionDisplay.label,
      sectionTitle: sectionDisplay.title
    };
  }

  window.RenaissanceReadingState = {
    COMPLETE_THRESHOLD,
    STORAGE_KEY,
    continueTarget,
    getLastRecord,
    getSectionRecord,
    isMeaningful,
    saveSectionProgress,
    shouldRestore
  };
})();
