(function () {
  const STORAGE_KEY = "renaissance-reading-state:v1";
  const VERSION = 1;
  const COMPLETE_THRESHOLD = 0.92;
  const MIN_MEANINGFUL_PROGRESS = 0.04;
  const MIN_RESTORE_PROGRESS = 0.03;
  const MAX_RESTORE_PROGRESS = 0.9;
  const MAX_PARAGRAPH_SIGNATURE_LENGTH = 220;

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

  function paragraphSignatureFromText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, MAX_PARAGRAPH_SIGNATURE_LENGTH);
  }

  function normalizeParagraphSignature(value) {
    const signature = paragraphSignatureFromText(value);
    return signature || null;
  }

  // The attention model persists a compact read-set (which paragraphs were
  // actually read) plus an optional in-progress paragraph's dwell, so a reload
  // resumes mid-paragraph. Both are sanitized defensively — this data comes
  // back out of localStorage and must never crash the reader.
  function normalizeReadParagraphs(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const seen = new Set();
    value.forEach((entry) => {
      const index = Number.parseInt(entry, 10);
      if (Number.isFinite(index) && index > 0) {
        seen.add(index);
      }
    });
    return Array.from(seen).sort((a, b) => a - b);
  }

  function mergeReadParagraphs(previousList, incomingList) {
    const merged = new Set(normalizeReadParagraphs(previousList));
    normalizeReadParagraphs(incomingList).forEach((index) => merged.add(index));
    return Array.from(merged).sort((a, b) => a - b);
  }

  function normalizeAttentionPartial(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const index = Number.parseInt(value.index, 10);
    const dwellMs = Number(value.dwellMs);
    if (!Number.isFinite(index) || index <= 0 || !Number.isFinite(dwellMs) || dwellMs <= 0) {
      return null;
    }
    return { index, dwellMs };
  }

  // Completion means "you read it," not "you scrolled to the end." When the
  // attention-derived progress is present it decides completion; only records
  // that predate the attention model fall back to the scroll high-water mark.
  function deriveCompleted(attentionProgress, maxProgress, previousCompleted) {
    if (previousCompleted) {
      return true;
    }
    if (attentionProgress !== null) {
      return attentionProgress >= COMPLETE_THRESHOLD;
    }
    return maxProgress >= COMPLETE_THRESHOLD;
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
    const attentionProgress = normalizeRatio(raw.attentionProgress);
    const completed = deriveCompleted(attentionProgress, maxProgress, Boolean(raw.completed));
    const scrollY = Math.max(0, Number(raw.scrollY) || 0);
    const updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
    const resumeParagraphIndex = normalizePositiveInteger(raw.resumeParagraphIndex);
    const resumeParagraphRatio = normalizeRatio(raw.resumeParagraphRatio);
    const resumeParagraphSignature = normalizeParagraphSignature(raw.resumeParagraphSignature);
    const readParagraphs = normalizeReadParagraphs(raw.readParagraphs);
    const attentionPartial = normalizeAttentionPartial(raw.attentionPartial);

    return {
      essaySlug,
      sectionNumber,
      progress,
      maxProgress,
      attentionProgress,
      scrollY,
      completed,
      updatedAt,
      resumeParagraphIndex,
      resumeParagraphRatio,
      resumeParagraphSignature,
      readParagraphs,
      attentionPartial,
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
    const previousAttention = previous && previous.attentionProgress !== null && previous.attentionProgress !== undefined
      ? previous.attentionProgress
      : null;
    const incomingAttention = normalizeRatio(source.attentionProgress);
    // Attention progress is monotonic, mirroring maxProgress: a save that lacks
    // a fresh reading (or carries a lower number) never lowers it.
    const attentionProgress = incomingAttention !== null
      ? Math.max(incomingAttention, previousAttention || 0)
      : previousAttention;
    const readParagraphs = mergeReadParagraphs(previous ? previous.readParagraphs : [], source.readParagraphs);
    const attentionPartial = normalizeAttentionPartial(source.attentionPartial) ||
      (previous ? previous.attentionPartial : null);
    const completed = deriveCompleted(attentionProgress, maxProgress, Boolean(previous && previous.completed));
    const updatedAt = Number.isFinite(source.updatedAt) ? Number(source.updatedAt) : Date.now();
    const resumeParagraphIndex = normalizePositiveInteger(source.resumeParagraphIndex) ||
      (previous ? previous.resumeParagraphIndex : null);
    const resumeParagraphRatio = normalizeRatio(source.resumeParagraphRatio);
    const resolvedResumeParagraphRatio = resumeParagraphRatio !== null
      ? resumeParagraphRatio
      : previous ? previous.resumeParagraphRatio : null;
    const resumeParagraphSignature = normalizeParagraphSignature(source.resumeParagraphSignature) ||
      (previous ? previous.resumeParagraphSignature : null);

    const record = {
      essaySlug,
      sectionNumber,
      progress,
      maxProgress,
      attentionProgress,
      scrollY: Math.max(0, Number(source.scrollY) || 0),
      completed,
      updatedAt,
      resumeParagraphIndex,
      resumeParagraphRatio: resolvedResumeParagraphRatio,
      resumeParagraphSignature,
      readParagraphs,
      attentionPartial,
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
      (normalized.scrollY > 80 || normalized.resumeParagraphIndex !== null || normalized.resumeParagraphSignature !== null)
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
      attentionProgress: last.attentionProgress,
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
    paragraphSignatureFromText,
    saveSectionProgress,
    shouldRestore
  };
})();
