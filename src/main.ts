import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
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

interface ConvertPayload {
  inputPath: string;
  outputPath: string;
  title?: string;
  author?: string;
  coverPage?: number;
}

interface PdfMetadata {
  pageCount: number;
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

const dependencyStatus = document.querySelector<HTMLDivElement>("#dependency-status");
const dependencyTitle = document.querySelector<HTMLElement>("#dependency-title");
const dependencyCopy = document.querySelector<HTMLParagraphElement>("#dependency-copy");
const dependencyVersion = document.querySelector<HTMLElement>("#dependency-version");
const dependencyPill = document.querySelector<HTMLSpanElement>("#dependency-pill");
const conversionStatus = document.querySelector<HTMLDivElement>("#conversion-status");
const inputPathField = document.querySelector<HTMLInputElement>("#input-path");
const outputPathField = document.querySelector<HTMLInputElement>("#output-path");
const titleField = document.querySelector<HTMLInputElement>("#title");
const authorField = document.querySelector<HTMLInputElement>("#author");
const convertForm = document.querySelector<HTMLFormElement>("#convert-form");
const submitButton = document.querySelector<HTMLButtonElement>("#submit-button");
const refreshDepsButton = document.querySelector<HTMLButtonElement>("#refresh-deps");
const pickInputButton = document.querySelector<HTMLButtonElement>("#pick-input");
const pickOutputButton = document.querySelector<HTMLButtonElement>("#pick-output");
const coverPageField = document.querySelector<HTMLInputElement>("#cover-page");
const loadCoverPreviewButton = document.querySelector<HTMLButtonElement>("#load-cover-preview");
const previousCoverPageButton = document.querySelector<HTMLButtonElement>("#prev-cover-page");
const nextCoverPageButton = document.querySelector<HTMLButtonElement>("#next-cover-page");
const coverPreviewImage = document.querySelector<HTMLImageElement>("#cover-preview-image");
const coverPreviewPlaceholder = document.querySelector<HTMLDivElement>("#cover-preview-placeholder");
const pdfMeta = document.querySelector<HTMLParagraphElement>("#pdf-meta");
const coverSummary = document.querySelector<HTMLSpanElement>("#cover-summary");
const activityTitle = document.querySelector<HTMLParagraphElement>("#activity-title");
const activitySubtitle = document.querySelector<HTMLParagraphElement>("#activity-subtitle");
const activityBadge = document.querySelector<HTMLSpanElement>("#activity-badge");
const progressTrack = document.querySelector<HTMLDivElement>("#progress-track");
const documentPill = document.querySelector<HTMLSpanElement>("#document-pill");
const wizardSteps = Array.from(document.querySelectorAll<HTMLButtonElement>(".wizard-step"));
const stepCards = Array.from(document.querySelectorAll<HTMLElement>(".step-card"));
const nextToStep2Button = document.querySelector<HTMLButtonElement>("#to-step-2");
const nextToStep3Button = document.querySelector<HTMLButtonElement>("#to-step-3");
const nextToStep4Button = document.querySelector<HTMLButtonElement>("#to-step-4");
const backButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-step-back]"));

if (
  !dependencyStatus ||
  !dependencyTitle ||
  !dependencyCopy ||
  !dependencyVersion ||
  !dependencyPill ||
  !conversionStatus ||
  !inputPathField ||
  !outputPathField ||
  !titleField ||
  !authorField ||
  !convertForm ||
  !submitButton ||
  !refreshDepsButton ||
  !pickInputButton ||
  !pickOutputButton ||
  !coverPageField ||
  !loadCoverPreviewButton ||
  !previousCoverPageButton ||
  !nextCoverPageButton ||
  !coverPreviewImage ||
  !coverPreviewPlaceholder ||
  !pdfMeta ||
  !coverSummary ||
  !activityTitle ||
  !activitySubtitle ||
  !activityBadge ||
  !progressTrack ||
  !documentPill ||
  !nextToStep2Button ||
  !nextToStep3Button ||
  !nextToStep4Button
) {
  throw new Error("Application UI failed to initialize.");
}

let currentDependencyStatus: DependencyStatus | null = null;
let pdfMetadata: PdfMetadata | null = null;
let currentLogLines: string[] = [];
let activeStep = 1;

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

const basenameWithoutExtension = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const filename = normalized.split("/").pop() ?? "output";
  return filename.replace(/\.[^.]+$/, "");
};

const clampCoverPage = (pageNumber: number) => {
  const pageCount = pdfMetadata?.pageCount ?? 1;
  return Math.min(Math.max(pageNumber, 1), pageCount);
};

const getMaxUnlockedStep = () => {
  if (!currentDependencyStatus?.available) {
    return 1;
  }

  if (!inputPathField.value.trim() || !outputPathField.value.trim()) {
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
    button.disabled = step > maxUnlockedStep;
  });

  stepCards.forEach((card) => {
    const step = Number(card.dataset.step);
    card.hidden = step !== activeStep;
  });

  nextToStep2Button.disabled = !currentDependencyStatus?.available;
  nextToStep3Button.disabled = !inputPathField.value.trim() || !outputPathField.value.trim() || !pdfMetadata;
  nextToStep4Button.disabled = !pdfMetadata;
};

const goToStep = (step: number) => {
  activeStep = Math.min(step, getMaxUnlockedStep());
  updateWizardState();
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
  submitButton.disabled = busy;
  pickInputButton.disabled = busy;
  pickOutputButton.disabled = busy;
  refreshDepsButton.disabled = busy;
  loadCoverPreviewButton.disabled = busy || !inputPathField.value.trim();
  previousCoverPageButton.disabled = busy || !pdfMetadata;
  nextCoverPageButton.disabled = busy || !pdfMetadata;
  coverPageField.disabled = busy || !pdfMetadata;
  nextToStep2Button.disabled = busy || !currentDependencyStatus?.available;
  nextToStep3Button.disabled = busy || !inputPathField.value.trim() || !outputPathField.value.trim() || !pdfMetadata;
  nextToStep4Button.disabled = busy || !pdfMetadata;
};

const updateDocumentState = () => {
  const ready = Boolean(inputPathField.value.trim() && outputPathField.value.trim());
  documentPill.textContent = ready ? "Dokumen siap" : "Belum siap";
  documentPill.dataset.state = ready ? "success" : "idle";
  updateWizardState();
};

const updateCoverUiMeta = () => {
  if (!pdfMetadata) {
    pdfMeta.textContent = "Default cover memakai halaman 1 PDF. Kamu bisa ganti sebelum convert.";
    coverSummary.textContent = "Belum ada preview";
    coverPageField.value = "1";
    coverPageField.max = "1";
    updateWizardState();
    return;
  }

  coverPageField.max = String(pdfMetadata.pageCount);
  pdfMeta.textContent = `PDF terdeteksi memiliki ${pdfMetadata.pageCount} halaman. Cover akan diambil dari halaman yang kamu pilih.`;
  coverSummary.textContent = `Cover: halaman ${coverPageField.value} / ${pdfMetadata.pageCount}`;
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

const inspectPdf = async (inputPath: string) => {
  pdfMetadata = null;
  updateCoverUiMeta();
  setCoverPreviewLoading("Membaca metadata PDF...");

  try {
    const metadata = await invoke<PdfMetadata>("inspect_pdf", { request: inputPath });
    pdfMetadata = metadata;
    coverPageField.value = "1";
    updateCoverUiMeta();
    await loadCoverPreview(1);
  } catch (error) {
    pdfMetadata = null;
    updateCoverUiMeta();
    setCoverPreviewLoading(`Gagal memuat metadata PDF: ${String(error)}`);
  } finally {
    setBusy(false);
    updateWizardState();
  }
};

const loadCoverPreview = async (pageNumber: number) => {
  const inputPath = inputPathField.value.trim();
  if (!inputPath) {
    setCoverPreviewLoading("Pilih PDF untuk memuat preview cover.");
    return;
  }

  if (!pdfMetadata) {
    setCoverPreviewLoading("Metadata PDF belum siap.");
    return;
  }

  const normalizedPage = clampCoverPage(pageNumber);
  coverPageField.value = String(normalizedPage);
  setCoverPreviewLoading(`Merender halaman ${normalizedPage} sebagai cover...`);
  loadCoverPreviewButton.disabled = true;

  try {
    const preview = await invoke<PdfPreviewResponse>("preview_pdf_page", {
      request: {
        inputPath,
        pageNumber: normalizedPage
      }
    });

    pdfMetadata = { pageCount: preview.pageCount };
    coverPageField.max = String(preview.pageCount);
    coverPageField.value = String(preview.pageNumber);
    setCoverPreviewImage(preview);
    updateCoverUiMeta();
  } catch (error) {
    setCoverPreviewLoading(`Gagal merender preview cover: ${String(error)}`);
  } finally {
    loadCoverPreviewButton.disabled = false;
    setBusy(false);
    updateWizardState();
  }
};

const chooseInputPdf = async () => {
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });

  if (typeof selected !== "string") {
    return;
  }

  inputPathField.value = selected;

  if (!outputPathField.value) {
    outputPathField.value = selected.replace(/\.[^.]+$/, ".epub");
  }

  if (!titleField.value) {
    titleField.value = basenameWithoutExtension(selected);
  }

  updateDocumentState();
  setBusy(true);
  await inspectPdf(selected);
  goToStep(3);
};

const chooseOutputEpub = async () => {
  const selected = await save({
    filters: [{ name: "EPUB", extensions: ["epub"] }],
    defaultPath: outputPathField.value || (inputPathField.value ? `${basenameWithoutExtension(inputPathField.value)}.epub` : "book.epub")
  });

  if (typeof selected === "string") {
    outputPathField.value = selected.endsWith(".epub") ? selected : `${selected}.epub`;
    updateDocumentState();
  }
};

const runConversion = async (payload: ConvertPayload) => {
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
    const result = await invoke<ConversionResult>("convert_pdf_to_epub", { request: payload });
    appendLogLine(`EPUB berhasil dibuat di: ${result.outputPath}`, "success");
    setActivityState(
      "Konversi selesai",
      "EPUB berhasil dibuat dan cover diambil dari halaman PDF yang dipilih.",
      "Success",
      "success",
      false
    );
  } catch (error) {
    appendLogLine(`Konversi gagal: ${String(error)}`, "error");
    setActivityState(
      "Konversi gagal",
      "Periksa log di bawah untuk melihat detail kegagalannya.",
      "Error",
      "error",
      false
    );
  } finally {
    setBusy(false);
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
    const target = Number(button.dataset.stepBack);
    goToStep(target);
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

pickOutputButton.addEventListener("click", () => {
  void chooseOutputEpub();
});

refreshDepsButton.addEventListener("click", () => {
  void refreshDependencies();
});

loadCoverPreviewButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1"));
});

previousCoverPageButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1") - 1);
});

nextCoverPageButton.addEventListener("click", () => {
  void changeCoverPage(Number(coverPageField.value || "1") + 1);
});

coverPageField.addEventListener("change", () => {
  void changeCoverPage(Number(coverPageField.value || "1"));
});

convertForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const inputPath = inputPathField.value.trim();
  const outputPath = outputPathField.value.trim();

  if (!currentDependencyStatus?.available) {
    setLogMessage("Calibre `ebook-convert` belum tersedia. Install dulu sebelum konversi.", "error");
    goToStep(1);
    return;
  }

  if (!inputPath || !outputPath) {
    setLogMessage("Pilih file PDF dan lokasi output EPUB terlebih dahulu.", "error");
    goToStep(2);
    return;
  }

  goToStep(4);
  void runConversion({
    inputPath,
    outputPath,
    title: titleField.value.trim() || undefined,
    author: authorField.value.trim() || undefined,
    coverPage: Number(coverPageField.value || "1")
  });
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
    case "converting":
      setActivityState("Sedang convert", payload.message, "Converting", "running", true);
      break;
    case "success":
      setActivityState("Konversi selesai", payload.message, "Success", "success", false);
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

setCoverPreviewLoading("Pilih PDF untuk memuat preview cover.");
resetLogs("idle");
setActivityState(
  "Belum ada proses.",
  "Jalankan konversi setelah PDF, output, dan cover sudah siap.",
  "Idle",
  "idle",
  false
);
updateDocumentState();
updateWizardState();
void refreshDependencies();
