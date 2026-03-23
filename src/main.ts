import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";

interface DependencyStatus {
  available: boolean;
  version: string | null;
  message: string;
}

interface ConversionResult {
  success: boolean;
  outputPath: string;
  log: string;
}

type OutputPreset = "small" | "balanced" | "quality";
type KindleProfile = "general" | "paperwhite" | "scribe";
type BatchJobStatus = "pending" | "running" | "success" | "error" | "cancelled";

interface ConvertPayload {
  inputPath: string;
  outputPath: string;
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  series?: string;
  tags?: string;
  description?: string;
  coverPage?: number;
  outputPreset?: OutputPreset;
  kindleProfile?: KindleProfile;
  useOcr?: boolean;
}

interface PdfMetadata {
  pageCount: number;
  suggestedCoverPage: number;
  isScanLikely: boolean;
  sampleTextCharacters: number;
}

interface PdfPreviewResponse {
  pageCount: number;
  pageNumber: number;
  dataUrl: string;
}

interface ConversionProgressEvent {
  stage: string;
  message: string;
  detail: string | null;
}

interface JobHistoryEntry {
  id: string;
  inputPath: string;
  outputPath: string;
  status: "success" | "failed" | "cancelled";
  inputSizeBytes: number | null;
  outputSizeBytes: number | null;
  durationMs: number;
  timestampMs: number;
  title: string | null;
  author: string | null;
  language: string | null;
  publisher: string | null;
  series: string | null;
  tags: string | null;
  outputPreset: OutputPreset;
  kindleProfile: KindleProfile;
  coverPage: number;
  usedOcr: boolean;
  validationMessage: string | null;
}

interface BatchJob {
  id: string;
  inputPath: string;
  outputPath: string;
  title: string;
  pageCount: number;
  suggestedCoverPage: number;
  isScanLikely: boolean;
  sampleTextCharacters: number;
  status: BatchJobStatus;
  message: string | null;
}

const query = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
};

const dependencyStatus = query<HTMLDivElement>("#dependency-status");
const dependencyTitle = query<HTMLElement>("#dependency-title");
const dependencyCopy = query<HTMLParagraphElement>("#dependency-copy");
const dependencyVersion = query<HTMLElement>("#dependency-version");
const dependencyPill = query<HTMLSpanElement>("#dependency-pill");
const conversionStatus = query<HTMLDivElement>("#conversion-status");
const inputPathField = query<HTMLInputElement>("#input-path");
const outputPathField = query<HTMLInputElement>("#output-path");
const batchOutputDirField = query<HTMLInputElement>("#batch-output-dir");
const titleField = query<HTMLInputElement>("#title");
const authorField = query<HTMLInputElement>("#author");
const languageField = query<HTMLInputElement>("#language");
const publisherField = query<HTMLInputElement>("#publisher");
const seriesField = query<HTMLInputElement>("#series");
const tagsField = query<HTMLInputElement>("#tags");
const descriptionField = query<HTMLTextAreaElement>("#description");
const convertForm = query<HTMLFormElement>("#convert-form");
const submitButton = query<HTMLButtonElement>("#submit-button");
const cancelButton = query<HTMLButtonElement>("#cancel-button");
const refreshDepsButton = query<HTMLButtonElement>("#refresh-deps");
const pickInputButton = query<HTMLButtonElement>("#pick-input");
const pickBatchButton = query<HTMLButtonElement>("#pick-batch");
const resetQueueButton = query<HTMLButtonElement>("#reset-queue");
const pickOutputButton = query<HTMLButtonElement>("#pick-output");
const pickBatchOutputButton = query<HTMLButtonElement>("#pick-batch-output");
const coverPageField = query<HTMLInputElement>("#cover-page");
const loadCoverPreviewButton = query<HTMLButtonElement>("#load-cover-preview");
const previousCoverPageButton = query<HTMLButtonElement>("#prev-cover-page");
const nextCoverPageButton = query<HTMLButtonElement>("#next-cover-page");
const useSuggestedCoverButton = query<HTMLButtonElement>("#use-suggested-cover");
const coverPreviewImage = query<HTMLImageElement>("#cover-preview-image");
const coverPreviewPlaceholder = query<HTMLDivElement>("#cover-preview-placeholder");
const pdfMeta = query<HTMLParagraphElement>("#pdf-meta");
const coverSummary = query<HTMLSpanElement>("#cover-summary");
const activityTitle = query<HTMLParagraphElement>("#activity-title");
const activitySubtitle = query<HTMLParagraphElement>("#activity-subtitle");
const activityBadge = query<HTMLSpanElement>("#activity-badge");
const progressTrack = query<HTMLDivElement>("#progress-track");
const documentPill = query<HTMLSpanElement>("#document-pill");
const batchPill = query<HTMLSpanElement>("#batch-pill");
const dropZone = query<HTMLDivElement>("#drop-zone");
const dropZoneTitle = query<HTMLElement>("#drop-zone-title");
const dropZoneCopy = query<HTMLParagraphElement>("#drop-zone-copy");
const ocrSummary = query<HTMLParagraphElement>("#ocr-summary");
const queueSummaryChip = query<HTMLSpanElement>("#queue-summary");
const smartCoverChip = query<HTMLSpanElement>("#smart-cover-chip");
const scanChip = query<HTMLSpanElement>("#scan-chip");
const scanAnalysisTitle = query<HTMLElement>("#scan-analysis-title");
const scanAnalysisCopy = query<HTMLParagraphElement>("#scan-analysis-copy");
const smartCoverTitle = query<HTMLElement>("#smart-cover-title");
const smartCoverCopy = query<HTMLParagraphElement>("#smart-cover-copy");
const batchCoverModeTitle = query<HTMLElement>("#batch-cover-mode-title");
const batchCoverModeCopy = query<HTMLParagraphElement>("#batch-cover-mode-copy");
const batchQueue = query<HTMLDivElement>("#batch-queue");
const batchProgress = query<HTMLDivElement>("#batch-progress");
const historyList = query<HTMLDivElement>("#history-list");
const retryFailedButton = query<HTMLButtonElement>("#retry-failed");
const openOutputButton = query<HTMLButtonElement>("#open-output");
const revealOutputButton = query<HTMLButtonElement>("#reveal-output");
const useOcrField = query<HTMLInputElement>("#use-ocr");

const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".preset-option"));
const kindleButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".kindle-option"));
const wizardSteps = Array.from(document.querySelectorAll<HTMLButtonElement>(".wizard-step"));
const stepCards = Array.from(document.querySelectorAll<HTMLElement>(".step-card"));
const nextToStep2Button = query<HTMLButtonElement>("#to-step-2");
const nextToStep3Button = query<HTMLButtonElement>("#to-step-3");
const nextToStep4Button = query<HTMLButtonElement>("#to-step-4");
const backButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-step-back]"));

let currentDependencyStatus: DependencyStatus | null = null;
let pdfMetadata: PdfMetadata | null = null;
let currentLogLines: string[] = [];
let historyEntries: JobHistoryEntry[] = [];
let batchJobs: BatchJob[] = [];
let activeStep = 1;
let selectedPreset: OutputPreset = "balanced";
let selectedKindleProfile: KindleProfile = "general";
let suggestedCoverPage = 1;
let isBusy = false;
let isConverting = false;
let isCancelling = false;
let lastOutputPath = "";

const PRESET_STORAGE_KEY = "kindle-create.output-preset";
const KINDLE_STORAGE_KEY = "kindle-create.kindle-profile";
const OCR_STORAGE_KEY = "kindle-create.use-ocr";

const presetMeta: Record<OutputPreset, { title: string; summary: string }> = {
  small: {
    title: "Ukuran Kecil",
    summary: "Memperkecil gambar dan cover secara agresif agar EPUB lebih ringan."
  },
  balanced: {
    title: "Seimbang",
    summary: "Ukuran file dan kualitas visual seimbang untuk mayoritas PDF."
  },
  quality: {
    title: "Kualitas Tinggi",
    summary: "Menjaga detail gambar lebih tinggi dengan ukuran file yang biasanya lebih besar."
  }
};

const kindleMeta: Record<KindleProfile, { title: string; summary: string }> = {
  general: {
    title: "General Kindle",
    summary: "Profil aman untuk banyak model Kindle dengan kompromi visual yang netral."
  },
  paperwhite: {
    title: "Paperwhite",
    summary: "Di-tune untuk layar e-ink HD yang lebih padat dan tampilan teks yang rapat."
  },
  scribe: {
    title: "Scribe",
    summary: "Resolusi gambar, margin, dan line height dibuat lebih lega untuk layar besar."
  }
};

const basenameWithoutExtension = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? "output";
  return filename.replace(/\.[^.]+$/, "");
};

const dirname = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
};

const joinPath = (directory: string, filename: string) => {
  if (!directory) {
    return filename;
  }

  const normalized = directory.replace(/\/+$/, "");
  return `${normalized}/${filename}`;
};

const isBatchMode = () => batchJobs.length > 1;

const deriveOutputPath = (inputPath: string) => {
  const directory = batchOutputDirField.value.trim() || dirname(inputPath);
  return joinPath(directory, `${basenameWithoutExtension(inputPath)}.epub`);
};

const createBatchJob = (inputPath: string, metadata: PdfMetadata): BatchJob => ({
  id: `${inputPath}-${metadata.pageCount}-${metadata.suggestedCoverPage}`,
  inputPath,
  outputPath: deriveOutputPath(inputPath),
  title: basenameWithoutExtension(inputPath),
  pageCount: metadata.pageCount,
  suggestedCoverPage: metadata.suggestedCoverPage,
  isScanLikely: metadata.isScanLikely,
  sampleTextCharacters: metadata.sampleTextCharacters,
  status: "pending",
  message: null
});

const clampCoverPage = (pageNumber: number) => {
  const pageCount = pdfMetadata?.pageCount ?? 1;
  return Math.min(Math.max(pageNumber, 1), pageCount);
};

const formatBytes = (value: number | null) => {
  if (!value || value <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let current = value;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const formatDuration = (value: number) => {
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)} dtk`;
  }
  return `${Math.round(value / 1000 / 60)} mnt`;
};

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));

const getStatusMeta = (status: BatchJobStatus | JobHistoryEntry["status"]) => {
  switch (status) {
    case "success":
      return { label: "Success", state: "success" };
    case "error":
    case "failed":
      return { label: "Error", state: "error" };
    case "cancelled":
      return { label: "Cancelled", state: "error" };
    case "running":
      return { label: "Running", state: "running" };
    default:
      return { label: "Pending", state: "idle" };
  }
};

const setLogMessage = (message: string, state: "idle" | "running" | "success" | "error" = "idle") => {
  conversionStatus.dataset.state = state;
  conversionStatus.textContent = message;
};

const resetLogs = (state: "idle" | "running" | "success" | "error" = "idle") => {
  currentLogLines = [];
  setLogMessage("Belum ada log proses.", state);
};

const appendLogLine = (line: string, state: "idle" | "running" | "success" | "error" = "running") => {
  currentLogLines.push(line);
  setLogMessage(currentLogLines.join("\n"), state);
};

const setActivityState = (
  title: string,
  subtitle: string,
  badge: string,
  state: "idle" | "running" | "success" | "error",
  active = false
) => {
  activityTitle.textContent = title;
  activitySubtitle.textContent = subtitle;
  activityBadge.textContent = badge;
  activityBadge.dataset.state = state;
  progressTrack.dataset.active = active ? "true" : "false";
};

const syncCancelUi = () => {
  cancelButton.disabled = !isConverting || isCancelling;
  cancelButton.textContent = isCancelling ? "Membatalkan..." : "Batalkan Konversi";
};

const syncOutputActions = () => {
  const available = Boolean(lastOutputPath) && !isConverting;
  openOutputButton.disabled = !available;
  revealOutputButton.disabled = !available;
};

const setDropZoneState = (
  state: "idle" | "active" | "ready" | "error",
  title: string,
  description: string
) => {
  dropZone.dataset.state = state;
  dropZoneTitle.textContent = title;
  dropZoneCopy.textContent = description;
};

const syncPresetUi = () => {
  presetButtons.forEach((button) => {
    const active = button.dataset.preset === selectedPreset;
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

};

const syncKindleUi = () => {
  kindleButtons.forEach((button) => {
    const active = button.dataset.kindleProfile === selectedKindleProfile;
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });

};

const renderHistory = () => {
  if (historyEntries.length === 0) {
    historyList.innerHTML = `<div class="empty-state">Belum ada riwayat konversi.</div>`;
    return;
  }

  historyList.innerHTML = historyEntries
    .map((entry) => {
      const status = getStatusMeta(entry.status);
      const title = entry.title ?? basenameWithoutExtension(entry.inputPath);
      return `
        <article class="history-item" data-state="${status.state}">
          <div class="history-main">
            <div>
              <strong>${title}</strong>
              <p class="subtle history-path">${entry.outputPath}</p>
            </div>
            <span class="pill" data-state="${status.state}">${status.label}</span>
          </div>
          <div class="meta-list">
            <span class="meta-chip">${formatTimestamp(entry.timestampMs)}</span>
            <span class="meta-chip">${formatDuration(entry.durationMs)}</span>
            <span class="meta-chip">${formatBytes(entry.inputSizeBytes)} -> ${formatBytes(entry.outputSizeBytes)}</span>
            <span class="meta-chip">${presetMeta[entry.outputPreset].title}</span>
            <span class="meta-chip">${kindleMeta[entry.kindleProfile].title}</span>
            ${entry.usedOcr ? `<span class="meta-chip">OCR</span>` : ""}
          </div>
          ${entry.validationMessage ? `<p class="subtle">${entry.validationMessage}</p>` : ""}
          <div class="history-actions">
            <button class="ghost-button" data-history-open="${entry.outputPath}" type="button">Buka EPUB</button>
            <button class="ghost-button" data-history-reveal="${entry.outputPath}" type="button">Reveal</button>
          </div>
        </article>
      `;
    })
    .join("");
};

const renderQueue = () => {
  const markup =
    batchJobs.length === 0
      ? `<div class="empty-state">Belum ada dokumen di queue.</div>`
      : batchJobs
          .map((job) => {
            const status = getStatusMeta(job.status);
            return `
              <article class="queue-item" data-state="${status.state}">
                <div class="queue-main">
                  <div>
                    <strong>${basenameWithoutExtension(job.inputPath)}</strong>
                    <p class="subtle queue-path">${job.inputPath}</p>
                  </div>
                  <span class="pill" data-state="${status.state}">${status.label}</span>
                </div>
                <div class="meta-list">
                  <span class="meta-chip">${job.pageCount} halaman</span>
                  <span class="meta-chip">Cover auto: ${job.suggestedCoverPage}</span>
                  <span class="meta-chip">${job.isScanLikely ? "Scan-likely" : "Text PDF"}</span>
                  <span class="meta-chip">${job.sampleTextCharacters} chars sample</span>
                </div>
                ${job.message ? `<p class="subtle">${job.message}</p>` : ""}
                <div class="history-actions">
                  <button class="ghost-button" data-queue-preview="${job.id}" type="button">Jadikan Aktif</button>
                  <button class="ghost-button" data-queue-remove="${job.id}" type="button">Hapus</button>
                </div>
              </article>
            `;
          })
          .join("");

  batchQueue.innerHTML = markup;
  batchProgress.innerHTML = markup;
};

const updateAnalysisUi = () => {
  if (!pdfMetadata) {
    scanAnalysisTitle.textContent = "Belum ada PDF";
    scanAnalysisCopy.textContent = "Setelah PDF dibaca, aplikasi akan mendeteksi indikasi scan dan saran cover awal.";
    smartCoverTitle.textContent = "Belum ada saran otomatis.";
    smartCoverCopy.textContent = "App akan menganalisis halaman awal untuk mencari cover yang paling masuk akal.";
    smartCoverChip.textContent = "Cover: -";
    scanChip.textContent = "OCR: belum dianalisis";
    return;
  }

  scanAnalysisTitle.textContent = pdfMetadata.isScanLikely ? "PDF cenderung hasil scan" : "PDF terlihat text-based";
  scanAnalysisCopy.textContent = pdfMetadata.isScanLikely
    ? "Mode OCR disarankan karena sample teks asli sangat sedikit pada halaman awal."
    : "Teks asli terdeteksi di PDF. OCR opsional dan biasanya tidak perlu dipaksa.";
  smartCoverTitle.textContent = `Saran cover: halaman ${suggestedCoverPage}`;
  smartCoverCopy.textContent = `Heuristik melihat ${pdfMetadata.pageCount} halaman dan merekomendasikan halaman ${suggestedCoverPage} sebagai kandidat cover awal.`;
  smartCoverChip.textContent = `Cover: ${suggestedCoverPage}`;
  scanChip.textContent = pdfMetadata.isScanLikely ? "OCR: disarankan" : "OCR: opsional";
  ocrSummary.textContent = pdfMetadata.isScanLikely
    ? "PDF ini terdeteksi cenderung scan. OCR akan membuat sumber HTML teks sebelum convert."
    : "PDF ini masih punya teks yang terbaca. OCR tetap bisa dipakai kalau hasil convert biasa kurang bagus.";
};

const updateCoverUiMeta = () => {
  if (!pdfMetadata) {
    pdfMeta.textContent = "Default cover memakai halaman 1 PDF. Kamu bisa ganti sebelum convert.";
    coverSummary.textContent = "Belum ada preview";
    coverPageField.value = "1";
    coverPageField.max = "1";
    batchCoverModeTitle.textContent = "Manual cover aktif.";
    batchCoverModeCopy.textContent = "Kalau queue batch aktif, item selain PDF aktif akan memakai cover rekomendasi masing-masing.";
    return;
  }

  coverPageField.max = String(pdfMetadata.pageCount);
  pdfMeta.textContent = `PDF terdeteksi memiliki ${pdfMetadata.pageCount} halaman. Saran cover awal ada di halaman ${suggestedCoverPage}.`;
  coverSummary.textContent = `Cover: halaman ${coverPageField.value} / ${pdfMetadata.pageCount}`;
  batchCoverModeTitle.textContent = isBatchMode() ? "Batch memakai smart cover." : "Manual cover aktif.";
  batchCoverModeCopy.textContent = isBatchMode()
    ? "File aktif bisa kamu preview manual, tetapi item lain di batch akan memakai cover rekomendasi masing-masing."
    : "Konversi single file akan memakai halaman cover yang kamu pilih di panel ini.";
};

const isDocumentReady = () => {
  if (isBatchMode()) {
    return batchJobs.length > 1 && Boolean(batchOutputDirField.value.trim());
  }

  return Boolean(inputPathField.value.trim() && outputPathField.value.trim());
};

const getMaxUnlockedStep = () => {
  if (!currentDependencyStatus?.available) {
    return 1;
  }

  if (!isDocumentReady()) {
    return 2;
  }

  if (!pdfMetadata) {
    return 2;
  }

  return 4;
};

const updateWizardState = () => {
  const maxUnlockedStep = getMaxUnlockedStep();

  wizardSteps.forEach((button) => {
    const step = Number(button.dataset.stepTarget);
    const isActive = step === activeStep;
    button.dataset.state = isActive ? "active" : step < activeStep ? "complete" : "idle";
    button.disabled = step > maxUnlockedStep || isBusy;
  });

  stepCards.forEach((card) => {
    const step = Number(card.dataset.step);
    card.hidden = step !== activeStep;
  });

  nextToStep2Button.disabled = isBusy || !currentDependencyStatus?.available;
  nextToStep3Button.disabled = isBusy || !isDocumentReady() || !pdfMetadata;
  nextToStep4Button.disabled = isBusy || !pdfMetadata;
};

const goToStep = (step: number) => {
  activeStep = Math.min(step, getMaxUnlockedStep());
  updateWizardState();
};

const setOutputPreset = (preset: OutputPreset) => {
  selectedPreset = preset;
  localStorage.setItem(PRESET_STORAGE_KEY, preset);
  syncPresetUi();
};

const setKindleProfile = (profile: KindleProfile) => {
  selectedKindleProfile = profile;
  localStorage.setItem(KINDLE_STORAGE_KEY, profile);
  syncKindleUi();
};

const setDependencyMessage = (status: DependencyStatus) => {
  currentDependencyStatus = status;
  dependencyStatus.dataset.state = status.available ? "ready" : "error";
  dependencyTitle.textContent = status.available ? "Calibre siap dipakai" : "Calibre belum siap";
  dependencyCopy.textContent = status.message;
  dependencyVersion.textContent = status.version ?? "Belum terdeteksi";
  dependencyPill.textContent = status.available ? "Ready" : "Needs Setup";
  dependencyPill.dataset.state = status.available ? "success" : "error";
  dependencyStatus.innerHTML = `
    <p>${status.message}</p>
    ${status.version ? `<p class="subtle">Versi terdeteksi: ${status.version}</p>` : ""}
  `;
  updateWizardState();
};

const setBusy = (busy: boolean) => {
  isBusy = busy;
  submitButton.disabled = busy;
  pickInputButton.disabled = busy;
  pickBatchButton.disabled = busy;
  resetQueueButton.disabled = busy;
  pickOutputButton.disabled = busy;
  pickBatchOutputButton.disabled = busy;
  refreshDepsButton.disabled = busy;
  retryFailedButton.disabled = busy || batchJobs.every((job) => !["error", "cancelled"].includes(job.status));
  presetButtons.forEach((button) => {
    button.disabled = busy;
  });
  kindleButtons.forEach((button) => {
    button.disabled = busy;
  });
  useOcrField.disabled = busy;
  loadCoverPreviewButton.disabled = busy || !inputPathField.value.trim();
  previousCoverPageButton.disabled = busy || !pdfMetadata;
  nextCoverPageButton.disabled = busy || !pdfMetadata;
  coverPageField.disabled = busy || !pdfMetadata;
  useSuggestedCoverButton.disabled = busy || !pdfMetadata;
  syncCancelUi();
  syncOutputActions();
  updateWizardState();
};

const syncDocumentUi = () => {
  const ready = isDocumentReady();
  documentPill.textContent = ready ? "Dokumen siap" : "Belum siap";
  documentPill.dataset.state = ready ? "success" : "idle";
  batchPill.textContent = isBatchMode() ? `Batch ${batchJobs.length}` : batchJobs.length === 1 ? "Single" : "Kosong";
  batchPill.dataset.state = batchJobs.length > 0 ? "success" : "idle";
  queueSummaryChip.textContent = `Queue: ${batchJobs.length}`;

  if (ready) {
    setDropZoneState("ready", "Dokumen siap dipakai", isBatchMode() ? "Queue batch sudah siap untuk diproses." : "Single PDF siap untuk dipreview dan dikonversi.");
  } else {
    setDropZoneState("idle", "Drop PDF di sini", "Drag file `.pdf` ke aplikasi. Kalau lebih dari satu file, app akan membentuk batch queue.");
  }

  renderQueue();
  updateWizardState();
};

const setCoverPreviewLoading = (message: string) => {
  coverPreviewImage.hidden = true;
  coverPreviewPlaceholder.hidden = false;
  coverPreviewPlaceholder.textContent = message;
};

const setCoverPreviewImage = (preview: PdfPreviewResponse) => {
  coverPreviewImage.src = preview.dataUrl;
  coverPreviewImage.hidden = false;
  coverPreviewPlaceholder.hidden = true;
  coverSummary.textContent = `Cover: halaman ${preview.pageNumber} / ${preview.pageCount}`;
};

const refreshHistory = async () => {
  try {
    historyEntries = await invoke<JobHistoryEntry[]>("list_job_history");
    renderHistory();
  } catch (error) {
    historyList.innerHTML = `<div class="empty-state">Gagal memuat riwayat: ${String(error)}</div>`;
  }
};

const inspectPdfMetadata = async (inputPath: string) => invoke<PdfMetadata>("inspect_pdf", { request: inputPath });

const applyActiveDocument = async (job: BatchJob, loadPreview = true) => {
  inputPathField.value = job.inputPath;
  outputPathField.value = job.outputPath;
  if (!titleField.value || titleField.value === basenameWithoutExtension(inputPathField.value)) {
    titleField.value = job.title;
  }

  pdfMetadata = {
    pageCount: job.pageCount,
    suggestedCoverPage: job.suggestedCoverPage,
    isScanLikely: job.isScanLikely,
    sampleTextCharacters: job.sampleTextCharacters
  };
  suggestedCoverPage = job.suggestedCoverPage;
  coverPageField.value = String(job.suggestedCoverPage);
  updateAnalysisUi();
  updateCoverUiMeta();
  syncDocumentUi();

  if (loadPreview) {
    await loadCoverPreview(job.suggestedCoverPage);
  }
};

const loadCoverPreview = async (pageNumber: number) => {
  const inputPath = inputPathField.value.trim();
  if (!inputPath || !pdfMetadata) {
    setCoverPreviewLoading("Pilih PDF untuk memuat preview cover.");
    return;
  }

  const normalizedPage = clampCoverPage(pageNumber);
  coverPageField.value = String(normalizedPage);
  setCoverPreviewLoading(`Merender halaman ${normalizedPage} sebagai cover...`);

  try {
    const preview = await invoke<PdfPreviewResponse>("preview_pdf_page", {
      request: {
        inputPath,
        pageNumber: normalizedPage
      }
    });

    coverPageField.max = String(preview.pageCount);
    coverPageField.value = String(preview.pageNumber);
    setCoverPreviewImage(preview);
    updateCoverUiMeta();
  } catch (error) {
    setCoverPreviewLoading(`Gagal merender preview cover: ${String(error)}`);
  } finally {
    updateWizardState();
  }
};

const setBatchOutputDirectory = (directory: string) => {
  batchOutputDirField.value = directory;
  batchJobs = batchJobs.map((job) => ({
    ...job,
    outputPath: joinPath(directory, `${basenameWithoutExtension(job.inputPath)}.epub`)
  }));

  const activeJob = batchJobs.find((job) => job.inputPath === inputPathField.value.trim()) ?? batchJobs[0];
  if (activeJob) {
    outputPathField.value = activeJob.outputPath;
  }

  syncDocumentUi();
};

const handleSelectedPdf = async (selected: string) => {
  setBusy(true);
  try {
    if (!batchOutputDirField.value.trim()) {
      batchOutputDirField.value = dirname(selected);
    }
    const metadata = await inspectPdfMetadata(selected);
    batchJobs = [createBatchJob(selected, metadata)];
    await applyActiveDocument(batchJobs[0]);
    goToStep(3);
  } catch (error) {
    pdfMetadata = null;
    updateAnalysisUi();
    updateCoverUiMeta();
    setCoverPreviewLoading(`Gagal memuat metadata PDF: ${String(error)}`);
  } finally {
    setBusy(false);
  }
};

const handleBatchSelection = async (paths: string[]) => {
  const filteredPaths = Array.from(new Set(paths.filter((path) => path.toLowerCase().endsWith(".pdf"))));
  if (filteredPaths.length === 0) {
    setDropZoneState("error", "File bukan PDF", "Drop atau pilih file dengan ekstensi `.pdf`.");
    return;
  }

  setBusy(true);
  setDropZoneState("active", "Memuat queue batch...", "Setiap PDF sedang dianalisis untuk cover dan indikasi scan.");
  try {
    if (!batchOutputDirField.value.trim()) {
      batchOutputDirField.value = dirname(filteredPaths[0]);
    }

    const jobs = await Promise.all(
      filteredPaths.map(async (path) => createBatchJob(path, await inspectPdfMetadata(path)))
    );
    batchJobs = jobs;
    setBatchOutputDirectory(batchOutputDirField.value.trim() || dirname(filteredPaths[0]));
    await applyActiveDocument(batchJobs[0]);
    goToStep(3);
  } catch (error) {
    setDropZoneState("error", "Queue gagal dimuat", String(error));
  } finally {
    setBusy(false);
  }
};

const resetQueue = () => {
  batchJobs = [];
  pdfMetadata = null;
  suggestedCoverPage = 1;
  inputPathField.value = "";
  outputPathField.value = "";
  batchOutputDirField.value = "";
  coverPageField.value = "1";
  titleField.value = "";
  authorField.value = "";
  languageField.value = "";
  publisherField.value = "";
  seriesField.value = "";
  tagsField.value = "";
  descriptionField.value = "";
  updateAnalysisUi();
  updateCoverUiMeta();
  syncDocumentUi();
  setCoverPreviewLoading("Pilih PDF untuk memuat preview cover.");
  goToStep(2);
};

const chooseInputPdf = async () => {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  if (typeof selected === "string") {
    await handleSelectedPdf(selected);
  }
};

const chooseBatchPdf = async () => {
  const selected = await open({
    directory: false,
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  if (Array.isArray(selected)) {
    await handleBatchSelection(selected);
  }
};

const chooseOutputEpub = async () => {
  const selected = await save({
    filters: [{ name: "EPUB", extensions: ["epub"] }],
    defaultPath:
      outputPathField.value || (inputPathField.value ? `${basenameWithoutExtension(inputPathField.value)}.epub` : "book.epub")
  });

  if (typeof selected === "string") {
    const normalized = selected.endsWith(".epub") ? selected : `${selected}.epub`;
    outputPathField.value = normalized;
    const activeInput = inputPathField.value.trim();
    batchJobs = batchJobs.map((job) => (job.inputPath === activeInput ? { ...job, outputPath: normalized } : job));
    syncDocumentUi();
  }
};

const chooseBatchOutputDirectory = async () => {
  const selected = await open({
    directory: true,
    multiple: false
  });

  if (typeof selected === "string") {
    setBatchOutputDirectory(selected);
  }
};

const refreshDependencies = async () => {
  dependencyStatus.dataset.state = "loading";
  dependencyTitle.textContent = "Sedang memeriksa Calibre...";
  dependencyCopy.textContent = "Tunggu sebentar sampai pengecekan selesai.";
  dependencyVersion.textContent = "Memeriksa...";
  dependencyPill.textContent = "Checking";
  dependencyPill.dataset.state = "running";
  dependencyStatus.textContent = "Memeriksa ketersediaan ebook-convert...";

  try {
    const status = await invoke<DependencyStatus>("check_dependencies");
    setDependencyMessage(status);
  } catch (error) {
    setDependencyMessage({
      available: false,
      version: null,
      message: `Gagal mengecek dependency: ${String(error)}`
    });
  }
};

const buildPayload = (job: BatchJob, batchMode: boolean): ConvertPayload => ({
  inputPath: job.inputPath,
  outputPath: batchMode ? job.outputPath : outputPathField.value.trim(),
  title: batchMode ? job.title : titleField.value.trim() || undefined,
  author: authorField.value.trim() || undefined,
  language: languageField.value.trim() || undefined,
  publisher: publisherField.value.trim() || undefined,
  series: seriesField.value.trim() || undefined,
  tags: tagsField.value.trim() || undefined,
  description: descriptionField.value.trim() || undefined,
  coverPage: batchMode ? job.suggestedCoverPage : Number(coverPageField.value || "1"),
  outputPreset: selectedPreset,
  kindleProfile: selectedKindleProfile,
  useOcr: useOcrField.checked
});

const updateBatchJob = (id: string, status: BatchJobStatus, message: string | null) => {
  batchJobs = batchJobs.map((job) => (job.id === id ? { ...job, status, message } : job));
  renderQueue();
  setBusy(isBusy);
};

const openPath = async (path: string) => {
  await invoke("open_path", { path });
};

const revealPath = async (path: string) => {
  await invoke("reveal_in_finder", { path });
};

const runSingleConversion = async () => {
  const activeInput = inputPathField.value.trim();
  const job =
    batchJobs.find((item) => item.inputPath === activeInput) ??
    (pdfMetadata
      ? createBatchJob(activeInput, pdfMetadata)
      : null);

  if (!job) {
    setLogMessage("Pilih file PDF dan lokasi output EPUB terlebih dahulu.", "error");
    goToStep(2);
    return;
  }

  isConverting = true;
  isCancelling = false;
  lastOutputPath = "";
  setBusy(true);
  resetLogs("running");
  setActivityState(
    "Konversi sedang berjalan",
    "Aplikasi akan menampilkan progres per tahap dan log converter secara live.",
    "Running",
    "running",
    true
  );
  appendLogLine("Memulai proses konversi...", "running");

  try {
    const result = await invoke<ConversionResult>("convert_pdf_to_epub", { request: buildPayload(job, false) });
    lastOutputPath = result.outputPath;
    appendLogLine(`EPUB berhasil dibuat di: ${result.outputPath}`, "success");
    setActivityState(
      "Konversi selesai",
      "EPUB berhasil dibuat dan siap dibuka langsung dari aplikasi.",
      "Success",
      "success",
      false
    );
    await refreshHistory();
  } catch (error) {
    const message = String(error);
    if (!message.toLowerCase().includes("dibatalkan")) {
      appendLogLine(`Konversi gagal: ${message}`, "error");
      setActivityState("Konversi gagal", "Periksa log di bawah untuk melihat detail kegagalannya.", "Error", "error", false);
      await refreshHistory();
    }
  } finally {
    isConverting = false;
    isCancelling = false;
    setBusy(false);
  }
};

const runBatchConversion = async (retryOnly = false) => {
  const eligibleJobs = batchJobs.filter((job) =>
    retryOnly ? ["error", "cancelled"].includes(job.status) : true
  );

  if (eligibleJobs.length === 0) {
    appendLogLine("Tidak ada job batch yang perlu dijalankan.", "idle");
    return;
  }

  isConverting = true;
  isCancelling = false;
  lastOutputPath = "";
  setBusy(true);
  resetLogs("running");
  setActivityState(
    "Batch conversion berjalan",
    "Queue diproses satu per satu. Kamu tetap bisa memantau status tiap file.",
    "Batch",
    "running",
    true
  );

  let successCount = 0;
  let failedCount = 0;
  let cancelled = false;

  for (let index = 0; index < eligibleJobs.length; index += 1) {
    const job = eligibleJobs[index];
    appendLogLine(`[${index + 1}/${eligibleJobs.length}] Memulai ${basenameWithoutExtension(job.inputPath)}...`, "running");
    updateBatchJob(job.id, "running", `Sedang convert ke ${job.outputPath}`);

    try {
      const result = await invoke<ConversionResult>("convert_pdf_to_epub", { request: buildPayload(job, true) });
      lastOutputPath = result.outputPath;
      updateBatchJob(job.id, "success", `Selesai: ${result.outputPath}`);
      successCount += 1;
      await refreshHistory();
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("dibatalkan")) {
        updateBatchJob(job.id, "cancelled", "Batch dihentikan oleh user.");
        cancelled = true;
        await refreshHistory();
        break;
      }
      updateBatchJob(job.id, "error", message);
      failedCount += 1;
      await refreshHistory();
    }
  }

  isConverting = false;
  isCancelling = false;
  setBusy(false);

  if (cancelled) {
    setActivityState(
      "Batch dibatalkan",
      "Queue berhenti pada item yang sedang aktif saat permintaan cancel dikirim.",
      "Cancelled",
      "error",
      false
    );
    return;
  }

  if (failedCount > 0) {
    setActivityState(
      "Batch selesai dengan catatan",
      `${successCount} sukses, ${failedCount} gagal. Kamu bisa pakai tombol Retry Failed.`,
      "Warning",
      "error",
      false
    );
  } else {
    setActivityState(
      "Batch selesai",
      `${successCount} file berhasil dikonversi.`,
      "Success",
      "success",
      false
    );
  }
};

const cancelConversion = async () => {
  if (!isConverting || isCancelling) {
    return;
  }

  isCancelling = true;
  syncCancelUi();
  appendLogLine("Meminta proses konversi untuk dibatalkan...", "running");
  setActivityState("Membatalkan konversi", "Aplikasi sedang meminta proses converter berhenti.", "Cancelling", "running", true);

  try {
    await invoke("cancel_conversion");
  } catch (error) {
    isCancelling = false;
    syncCancelUi();
    appendLogLine(`Gagal membatalkan konversi: ${String(error)}`, "error");
    setActivityState("Gagal membatalkan", "Permintaan cancel gagal dijalankan.", "Error", "error", false);
  }
};

const changeCoverPage = async (nextPage: number) => {
  if (!pdfMetadata) {
    return;
  }
  await loadCoverPreview(nextPage);
};

wizardSteps.forEach((button) => {
  button.addEventListener("click", () => {
    const step = Number(button.dataset.stepTarget);
    if (!button.disabled) {
      goToStep(step);
    }
  });
});

backButtons.forEach((button) => {
  button.addEventListener("click", () => {
    goToStep(Number(button.dataset.stepBack));
  });
});

nextToStep2Button.addEventListener("click", () => {
  goToStep(2);
});

nextToStep3Button.addEventListener("click", () => {
  goToStep(3);
});

nextToStep4Button.addEventListener("click", () => {
  goToStep(4);
});

pickInputButton.addEventListener("click", () => {
  void chooseInputPdf();
});

pickBatchButton.addEventListener("click", () => {
  void chooseBatchPdf();
});

resetQueueButton.addEventListener("click", () => {
  resetQueue();
});

pickOutputButton.addEventListener("click", () => {
  void chooseOutputEpub();
});

pickBatchOutputButton.addEventListener("click", () => {
  void chooseBatchOutputDirectory();
});

refreshDepsButton.addEventListener("click", () => {
  void refreshDependencies();
});

loadCoverPreviewButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1"));
});

useSuggestedCoverButton.addEventListener("click", () => {
  coverPageField.value = String(suggestedCoverPage);
  void loadCoverPreview(suggestedCoverPage);
});

previousCoverPageButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1") - 1);
});

nextCoverPageButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1") + 1);
});

cancelButton.addEventListener("click", () => {
  void cancelConversion();
});

retryFailedButton.addEventListener("click", () => {
  if (!isConverting) {
    void runBatchConversion(true);
  }
});

openOutputButton.addEventListener("click", () => {
  if (lastOutputPath) {
    void openPath(lastOutputPath);
  }
});

revealOutputButton.addEventListener("click", () => {
  if (lastOutputPath) {
    void revealPath(lastOutputPath);
  }
});

coverPageField.addEventListener("change", () => {
  void changeCoverPage(Number(coverPageField.value || "1"));
});

useOcrField.addEventListener("change", () => {
  localStorage.setItem(OCR_STORAGE_KEY, useOcrField.checked ? "true" : "false");
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.preset as OutputPreset | undefined;
    if (preset) {
      setOutputPreset(preset);
    }
  });
});

kindleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const profile = button.dataset.kindleProfile as KindleProfile | undefined;
    if (profile) {
      setKindleProfile(profile);
    }
  });
});

batchQueue.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const previewButton = target.closest<HTMLButtonElement>("[data-queue-preview]");
  if (previewButton) {
    const id = previewButton.dataset.queuePreview ?? "";
    const job = batchJobs.find((item) => item.id === id);
    if (job) {
      void applyActiveDocument(job);
      goToStep(3);
    }
    return;
  }

  const removeButton = target.closest<HTMLButtonElement>("[data-queue-remove]");
  if (removeButton) {
    const id = removeButton.dataset.queueRemove ?? "";
    batchJobs = batchJobs.filter((item) => item.id !== id);
    if (batchJobs.length > 0) {
      const nextJob = batchJobs[0];
      void applyActiveDocument(nextJob);
    } else {
      resetQueue();
    }
    syncDocumentUi();
  }
});

batchProgress.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const previewButton = target.closest<HTMLButtonElement>("[data-queue-preview]");
  if (previewButton) {
    const id = previewButton.dataset.queuePreview ?? "";
    const job = batchJobs.find((item) => item.id === id);
    if (job) {
      void applyActiveDocument(job);
      goToStep(3);
    }
  }
});

historyList.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const openButton = target.closest<HTMLButtonElement>("[data-history-open]");
  if (openButton?.dataset.historyOpen) {
    void openPath(openButton.dataset.historyOpen);
    return;
  }

  const revealButton = target.closest<HTMLButtonElement>("[data-history-reveal]");
  if (revealButton?.dataset.historyReveal) {
    void revealPath(revealButton.dataset.historyReveal);
  }
});

convertForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!currentDependencyStatus?.available) {
    setLogMessage("Calibre `ebook-convert` belum tersedia. Install dulu sebelum konversi.", "error");
    goToStep(1);
    return;
  }

  if (!isDocumentReady()) {
    setLogMessage("Pilih file PDF dan lokasi output terlebih dahulu.", "error");
    goToStep(2);
    return;
  }

  if (!pdfMetadata) {
    setLogMessage("Metadata PDF belum siap.", "error");
    goToStep(2);
    return;
  }

  goToStep(4);
  if (isBatchMode()) {
    batchJobs = batchJobs.map((job) => ({ ...job, status: "pending", message: null }));
    renderQueue();
    void runBatchConversion(false);
  } else {
    void runSingleConversion();
  }
});

void listen<ConversionProgressEvent>("conversion-progress", (event) => {
  const payload = event.payload;
  const detail = payload.detail?.trim();

  switch (payload.stage) {
    case "preparing":
      setActivityState("Menyiapkan konversi", payload.message, "Preparing", "running", true);
      break;
    case "cover-ready":
      setActivityState("Cover siap", payload.message, "Cover Ready", "running", true);
      break;
    case "ocr":
      setActivityState("Menjalankan OCR", payload.message, "OCR", "running", true);
      break;
    case "converting":
      setActivityState("Sedang convert", payload.message, "Converting", "running", true);
      break;
    case "validating":
      setActivityState("Memvalidasi EPUB", payload.message, "Validating", "running", true);
      break;
    case "warning":
      setActivityState("Selesai dengan peringatan", payload.message, "Warning", "error", false);
      break;
    case "success":
      setActivityState("Konversi selesai", payload.message, "Success", "success", false);
      break;
    case "cancelling":
      setActivityState("Membatalkan konversi", payload.message, "Cancelling", "running", true);
      break;
    case "cancelled":
      setActivityState("Konversi dibatalkan", payload.message, "Cancelled", "error", false);
      break;
    case "error":
      setActivityState("Konversi gagal", payload.message, "Error", "error", false);
      break;
    default:
      break;
  }

  if (detail) {
    appendLogLine(detail, payload.stage === "error" ? "error" : payload.stage === "success" ? "success" : "running");
  }
});

void getCurrentWindow().onDragDropEvent(async (event) => {
  if (isBusy) {
    return;
  }

  if (event.payload.type === "enter" || event.payload.type === "over") {
    setDropZoneState("active", "Lepaskan file untuk membuka PDF", "App akan memilih semua file PDF yang valid dari drag session ini.");
    return;
  }

  if (event.payload.type === "leave") {
    syncDocumentUi();
    return;
  }

  if (event.payload.type === "drop") {
    const pdfPaths = event.payload.paths.filter((path) => path.toLowerCase().endsWith(".pdf"));

    if (pdfPaths.length === 0) {
      setDropZoneState("error", "File bukan PDF", "Drop file dengan ekstensi `.pdf` untuk memulai proses.");
      goToStep(2);
      return;
    }

    goToStep(2);
    if (pdfPaths.length === 1) {
      await handleSelectedPdf(pdfPaths[0]);
    } else {
      await handleBatchSelection(pdfPaths);
    }
  }
});

setDropZoneState("idle", "Drop PDF di sini", "Drag file `.pdf` ke aplikasi. Kalau lebih dari satu file, app akan membentuk batch queue.");
setCoverPreviewLoading("Pilih PDF untuk memuat preview cover.");
resetLogs("idle");
setActivityState(
  "Belum ada proses.",
  "Jalankan konversi setelah PDF, output, dan cover sudah siap.",
  "Idle",
  "idle",
  false
);

{
  const savedPreset = localStorage.getItem(PRESET_STORAGE_KEY);
  if (savedPreset === "small" || savedPreset === "balanced" || savedPreset === "quality") {
    selectedPreset = savedPreset;
  }

  const savedKindleProfile = localStorage.getItem(KINDLE_STORAGE_KEY);
  if (savedKindleProfile === "general" || savedKindleProfile === "paperwhite" || savedKindleProfile === "scribe") {
    selectedKindleProfile = savedKindleProfile;
  }

  useOcrField.checked = localStorage.getItem(OCR_STORAGE_KEY) === "true";
}

syncPresetUi();
syncKindleUi();
updateAnalysisUi();
updateCoverUiMeta();
syncDocumentUi();
syncCancelUi();
syncOutputActions();
renderQueue();
renderHistory();
updateWizardState();
void refreshDependencies();
void refreshHistory();
