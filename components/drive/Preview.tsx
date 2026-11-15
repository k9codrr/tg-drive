"use client";

import { ChevronLeft, ChevronRight, Download, Loader2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KindIcon } from "./icons";
import {
  contentUrl,
  extOf,
  fetchBytes,
  formatBytes,
  formatDate,
  kindOf,
  KIND_LABEL,
  msg,
  type FileItem,
} from "./lib";
import { IconButton } from "./ui";

const MB = 1024 * 1024;
const LIMIT = { text: 2 * MB, sheet: 40 * MB, doc: 40 * MB, slides: 80 * MB, archive: 200 * MB, font: 20 * MB };

type State<T> = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: T };

/** Loads something for the viewer with cancellation, a retry button and readable errors. */
function useLoad<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<State<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const ctl = new AbortController();
    setState({ status: "loading" });
    loadRef
      .current(ctl.signal)
      .then((data) => !ctl.signal.aborted && setState({ status: "ready", data }))
      .catch((e) => !ctl.signal.aborted && setState({ status: "error", error: msg(e) }));
    return () => ctl.abort();
  }, [key, attempt]);
  return { state, retry: () => setAttempt((a) => a + 1) };
}

function Loading({ label = "Loading preview…" }: { label?: string }) {
  return (
    <div className="viewerMsg" role="status">
      <Loader2 size={28} className="spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

function Failed({ error, retry, file, onDownload }: { error: string; retry?: () => void; file: FileItem; onDownload: () => void }) {
  return (
    <div className="viewerMsg" role="alert">
      <KindIcon kind={kindOf(file.mime, file.name)} size={44} />
      <strong>Couldn&apos;t show this file</strong>
      <span className="muted">{error}</span>
      <div className="viewerMsgActions">
        {retry && (
          <button className="btn" onClick={retry}>
            <RotateCw size={16} aria-hidden /> Try again
          </button>
        )}
        <button className="btn primary" onClick={onDownload}>
          <Download size={16} aria-hidden /> Download
        </button>
      </div>
    </div>
  );
}

function NoPreview({ file, onDownload, reason }: { file: FileItem; onDownload: () => void; reason?: string }) {
  return (
    <div className="viewerMsg">
      <KindIcon kind={kindOf(file.mime, file.name)} size={56} />
      <strong>{file.name}</strong>
      <span className="muted">
        {reason ?? `${KIND_LABEL[kindOf(file.mime, file.name)]} files can't be previewed here.`} {formatBytes(file.size)}
      </span>
      <button className="btn primary" onClick={onDownload}>
        <Download size={16} aria-hidden /> Download
      </button>
    </div>
  );
}

// ---------- per-type viewers ----------

function ImageView({ file, onError }: { file: FileItem; onError: () => void }) {
  const [zoom, setZoom] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className={`imgStage ${zoom ? "zoom" : ""}`} onClick={() => setZoom((z) => !z)}>
      {!loaded && <Loading />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={contentUrl(file.id)}
        alt={file.name}
        onLoad={() => setLoaded(true)}
        onError={onError}
        style={loaded ? undefined : { opacity: 0 }}
        draggable={false}
      />
      <div className="zoomHint" aria-hidden>
        {zoom ? <ZoomOut size={16} /> : <ZoomIn size={16} />}
      </div>
    </div>
  );
}

function MediaView({ file, kind, onError }: { file: FileItem; kind: "video" | "audio"; onError: (m: string) => void }) {
  const fail = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const code = e.currentTarget.error?.code;
    onError(
      code === 4
        ? `Your browser can't play this ${kind} format (.${extOf(file.name)}). Download it to play it in another app.`
        : `The ${kind} stopped loading. Check your connection and try again.`,
    );
  };
  return kind === "video" ? (
    <video className="videoStage" src={contentUrl(file.id)} controls autoPlay playsInline preload="metadata" onError={fail} />
  ) : (
    <div className="audioStage">
      <KindIcon kind="audio" size={72} />
      <div className="audioName">{file.name}</div>
      <audio src={contentUrl(file.id)} controls autoPlay preload="metadata" onError={fail} />
    </div>
  );
}

function TextView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const { state, retry } = useLoad(file.id, async (signal) => {
    const buf = await fetchBytes(file.id, file.size > LIMIT.text ? LIMIT.text : undefined, signal);
    let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    if (extOf(file.name) === "json" && file.size <= LIMIT.text) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* show as-is */
      }
    }
    return { text, truncated: file.size > LIMIT.text };
  });
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  const lines = state.data.text.split("\n");
  return (
    <div className="docStage">
      {state.data.truncated && <div className="viewerNote">Showing the first 2 MB. Download to see everything.</div>}
      <pre className="codeView">
        {lines.map((l, i) => (
          <div key={i} className="codeLine">
            <span className="ln">{i + 1}</span>
            <span>{l || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function tooBig(file: FileItem, limit: number) {
  return file.size > limit ? `This file is ${formatBytes(file.size)}. Previews work up to ${formatBytes(limit)}.` : null;
}

function SheetView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const [active, setActive] = useState(0);
  const { state, retry } = useLoad(file.id, async (signal) => {
    const XLSX = await import("xlsx");
    const buf = await fetchBytes(file.id, undefined, signal);
    const wb = XLSX.read(buf, { type: "array", sheetRows: 1001, cellDates: true, dense: true });
    return wb.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true });
      return { name, rows: rows as string[][] };
    });
  });
  const big = tooBig(file, LIMIT.sheet);
  if (big) return <NoPreview file={file} onDownload={onDownload} reason={big} />;
  if (state.status === "loading") return <Loading label="Opening spreadsheet…" />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  const sheets = state.data;
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const width = Math.max(1, ...sheet.rows.slice(0, 200).map((r) => r.length));
  const col = (i: number) => {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  return (
    <div className="docStage sheetStage">
      <div className="sheetScroll">
        <table className="sheetTable">
          <thead>
            <tr>
              <th className="corner" />
              {Array.from({ length: width }, (_, i) => (
                <th key={i}>{col(i)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, ri) => (
              <tr key={ri}>
                <th>{ri + 1}</th>
                {Array.from({ length: width }, (_, ci) => (
                  <td key={ci}>{String(r[ci] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!sheet.rows.length && <div className="viewerNote">This sheet is empty.</div>}
      </div>
      {sheet.rows.length >= 1000 && <div className="viewerNote">Showing the first 1,000 rows.</div>}
      {sheets.length > 1 && (
        <div className="sheetTabs" role="tablist">
          {sheets.map((s, i) => (
            <button key={s.name} role="tab" aria-selected={i === active} className={i === active ? "on" : ""} onClick={() => setActive(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DOC_CSS = `body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2328;max-width:780px;margin:0 auto;padding:40px 48px;background:#fff}
img{max-width:100%;height:auto}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #d0d7de;padding:4px 8px}
h1,h2,h3{line-height:1.25}a{color:#0969da}p{margin:0 0 .8em}`;

function DocView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const ext = extOf(file.name);
  const { state, retry } = useLoad(file.id, async (signal) => {
    if (ext !== "docx") throw new Error("Only .docx Word files can be previewed.");
    const buf = await fetchBytes(file.id, undefined, signal);
    const mammoth = await import("mammoth");
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    return res.value;
  });
  if (ext !== "docx") return <NoPreview file={file} onDownload={onDownload} reason={`.${ext} files can't be previewed. Word .docx files can.`} />;
  const big = tooBig(file, LIMIT.doc);
  if (big) return <NoPreview file={file} onDownload={onDownload} reason={big} />;
  if (state.status === "loading") return <Loading label="Opening document…" />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${DOC_CSS}</style></head><body>${state.data || "<p><em>This document is empty.</em></p>"}</body></html>`;
  // sandbox="" : no scripts, no forms, no navigation of this page.
  return <iframe className="docFrame" sandbox="" srcDoc={html} title={file.name} />;
}

function SlidesView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const ext = extOf(file.name);
  const { state, retry } = useLoad(file.id, async (signal) => {
    if (ext !== "pptx") throw new Error("Only .pptx files can be previewed.");
    const buf = await fetchBytes(file.id, undefined, signal);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
    const parser = new DOMParser();
    return Promise.all(
      names.map(async (n) => {
        const xml = parser.parseFromString(await zip.file(n)!.async("text"), "application/xml");
        const paras = Array.from(xml.getElementsByTagNameNS("*", "p"))
          .map((p) =>
            Array.from(p.getElementsByTagNameNS("*", "t"))
              .map((t) => t.textContent ?? "")
              .join(""),
          )
          .filter((t) => t.trim());
        return paras;
      }),
    );
  });
  if (ext !== "pptx") return <NoPreview file={file} onDownload={onDownload} reason={`.${ext} files can't be previewed. PowerPoint .pptx files can.`} />;
  const big = tooBig(file, LIMIT.slides);
  if (big) return <NoPreview file={file} onDownload={onDownload} reason={big} />;
  if (state.status === "loading") return <Loading label="Opening presentation…" />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  return (
    <div className="docStage slidesStage">
      <div className="viewerNote">Text of each slide. Download the file to see the full layout.</div>
      {state.data.map((paras, i) => (
        <section key={i} className="slideCard" aria-label={`Slide ${i + 1}`}>
          <div className="slideNum">{i + 1}</div>
          {paras.length ? (
            <>
              <h3>{paras[0]}</h3>
              {paras.slice(1).map((p, j) => (
                <p key={j}>{p}</p>
              ))}
            </>
          ) : (
            <p className="muted">No text on this slide</p>
          )}
        </section>
      ))}
    </div>
  );
}

function ArchiveView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const ext = extOf(file.name);
  const { state, retry } = useLoad(file.id, async (signal) => {
    if (ext !== "zip") throw new Error("Only .zip archives can be previewed.");
    const buf = await fetchBytes(file.id, undefined, signal);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buf);
    const items: { name: string; dir: boolean; size: number }[] = [];
    zip.forEach((path, entry) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const size = (entry as any)._data?.uncompressedSize ?? 0;
      items.push({ name: path, dir: entry.dir, size });
    });
    return items.sort((a, b) => a.name.localeCompare(b.name));
  });
  if (ext !== "zip") return <NoPreview file={file} onDownload={onDownload} reason={`.${ext} archives can't be opened here. .zip files can.`} />;
  const big = tooBig(file, LIMIT.archive);
  if (big) return <NoPreview file={file} onDownload={onDownload} reason={big} />;
  if (state.status === "loading") return <Loading label="Reading archive…" />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  const files = state.data.filter((i) => !i.dir);
  return (
    <div className="docStage zipStage">
      <div className="viewerNote">
        {files.length} file{files.length === 1 ? "" : "s"} · {formatBytes(files.reduce((s, f) => s + f.size, 0))} unpacked
      </div>
      <ul className="zipList">
        {state.data.slice(0, 5000).map((it) => (
          <li key={it.name}>
            <KindIcon kind={it.dir ? "folder" : kindOf("", it.name)} size={16} />
            <span className="zipName">{it.name}</span>
            {!it.dir && <span className="muted">{formatBytes(it.size)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FontView({ file, onDownload }: { file: FileItem; onDownload: () => void }) {
  const family = `tgd-preview-${file.id}`;
  const { state, retry } = useLoad(file.id, async (signal) => {
    const buf = await fetchBytes(file.id, undefined, signal);
    const face = new FontFace(family, buf);
    await face.load();
    document.fonts.add(face);
    return true;
  });
  const big = tooBig(file, LIMIT.font);
  if (big) return <NoPreview file={file} onDownload={onDownload} reason={big} />;
  if (state.status === "loading") return <Loading label="Loading font…" />;
  if (state.status === "error") return <Failed error={state.error} retry={retry} file={file} onDownload={onDownload} />;
  return (
    <div className="docStage fontStage" style={{ fontFamily: `"${family}", sans-serif` }}>
      {[56, 36, 24, 16].map((s) => (
        <p key={s} style={{ fontSize: s }}>
          The quick brown fox jumps over the lazy dog
        </p>
      ))}
      <p style={{ fontSize: 22 }}>ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789</p>
    </div>
  );
}

// ---------- viewer shell ----------

export default function Preview({
  files,
  index,
  onIndex,
  onClose,
  onDownload,
}: {
  files: FileItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDownload: (f: FileItem) => void;
}) {
  const file = files[index];
  const [mediaError, setMediaError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const kind = useMemo(() => (file ? kindOf(file.mime, file.name) : "other"), [file]);

  useEffect(() => setMediaError(null), [file?.id]);

  const go = useCallback(
    (d: number) => {
      const n = index + d;
      if (n >= 0 && n < files.length) onIndex(n);
    },
    [index, files.length, onIndex],
  );

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    document.body.classList.add("noScroll");
    return () => {
      document.body.classList.remove("noScroll");
      prev?.focus?.();
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !(t instanceof HTMLMediaElement)) go(1);
      else if (e.key === "ArrowLeft" && !(t instanceof HTMLMediaElement)) go(-1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, onClose]);

  if (!file) return null;
  const download = () => onDownload(file);

  let body: React.ReactNode;
  if (file.status !== "ready") {
    body = <NoPreview file={file} onDownload={download} reason="This file hasn't finished uploading." />;
  } else if (mediaError) {
    body = <Failed error={mediaError} retry={() => setMediaError(null)} file={file} onDownload={download} />;
  } else if (kind === "image") {
    body = ["heic", "heif", "tif", "tiff"].includes(extOf(file.name)) ? (
      <NoPreview file={file} onDownload={download} reason="Browsers can't show this image format." />
    ) : (
      <ImageView key={file.id} file={file} onError={() => setMediaError("The image couldn't be loaded.")} />
    );
  } else if (kind === "video" || kind === "audio") {
    body = <MediaView key={file.id} file={file} kind={kind} onError={setMediaError} />;
  } else if (kind === "pdf") {
    body = <iframe key={file.id} className="pdfFrame" src={contentUrl(file.id)} title={file.name} />;
  } else if (kind === "text" || kind === "code") {
    body = <TextView key={file.id} file={file} onDownload={download} />;
  } else if (kind === "sheet") {
    body = <SheetView key={file.id} file={file} onDownload={download} />;
  } else if (kind === "doc") {
    body = <DocView key={file.id} file={file} onDownload={download} />;
  } else if (kind === "slides") {
    body = <SlidesView key={file.id} file={file} onDownload={download} />;
  } else if (kind === "archive") {
    body = <ArchiveView key={file.id} file={file} onDownload={download} />;
  } else if (kind === "font") {
    body = <FontView key={file.id} file={file} onDownload={download} />;
  } else {
    body = <NoPreview file={file} onDownload={download} />;
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Preview of ${file.name}`} ref={ref} tabIndex={-1}>
      <header className="viewerBar">
        <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
        <KindIcon kind={kind} size={20} />
        <div className="viewerTitle">
          <div className="viewerName" title={file.name}>
            {file.name}
          </div>
          <div className="viewerMeta">
            {KIND_LABEL[kind]} · {formatBytes(file.size)} · {formatDate(file.createdAt)}
          </div>
        </div>
        <div className="viewerSpacer" />
        {files.length > 1 && (
          <span className="viewerCount">
            {index + 1} / {files.length}
          </span>
        )}
        <button className="btn viewerDl" onClick={download} disabled={file.status !== "ready"}>
          <Download size={16} aria-hidden /> <span>Download</span>
        </button>
      </header>
      <div className="viewerBody" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {body}
      </div>
      {index > 0 && (
        <button className="viewerNav prev" aria-label="Previous file" onClick={() => go(-1)}>
          <ChevronLeft size={28} aria-hidden />
        </button>
      )}
      {index < files.length - 1 && (
        <button className="viewerNav next" aria-label="Next file" onClick={() => go(1)}>
          <ChevronRight size={28} aria-hidden />
        </button>
      )}
    </div>
  );
}
