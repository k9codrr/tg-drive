"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Cloud,
  Download,
  Eye,
  FileText,
  Film,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Loader2,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  MoreVertical,
  Music,
  Palette,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Trash2,
  Upload,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import DevicesModal from "./Devices";
import { FileTypeIcon, KindIcon, KindTile } from "./drive/icons";
import {
  api,
  canThumb,
  collectDropped,
  contentUrl,
  downloadFile,
  formatBytes,
  formatDate,
  kindOf,
  msg,
  type FileItem,
  type Folder,
  type GoogleAccount,
  type Listing,
  type Pending,
  type Pool,
  uploadFile,
} from "./drive/lib";
import Preview from "./drive/Preview";
import { applyPrefs, DESIGN_INFO, loadPrefs, savePrefs, type Prefs } from "./drive/theme";
import ThemePicker from "./drive/ThemePicker";
import { ConfirmDialog, IconButton, Menu, Modal, PromptDialog, Toasts, type MenuAnchor, type MenuItem, type Toast } from "./drive/ui";

export { formatBytes } from "./drive/lib";

// ---------- types ----------

type KindView = "image" | "video" | "audio" | "document";
type View = { type: "folder"; id: string | null } | { type: "recent" } | { type: "kind"; kind: KindView } | { type: "search"; q: string };
type Entry =
  | { key: string; type: "folder"; id: string; name: string; date: string; size: -1; folder: Folder }
  | { key: string; type: "file"; id: string; name: string; date: string; size: number; file: FileItem };
type SortKey = "name" | "date" | "size";
type Sort = { key: SortKey; dir: 1 | -1 };
type Filter = "all" | "folders" | "image" | "video" | "audio" | "document";
type JobStatus = "queued" | "uploading" | "done" | "error" | "cancelled";
type Job = { key: string; label: string; name: string; size: number; done: number; status: JobStatus; error?: string };
type Batch = { items: Pending[]; keys: string[]; target: string | null; dest: string };
type Dialog =
  | { kind: "newFolder" }
  | { kind: "rename"; entry: Entry }
  | { kind: "delete"; entries: Entry[] }
  | { kind: "move"; files: FileItem[] }
  | null;

const KIND_VIEWS: { kind: KindView; label: string; icon: LucideIcon }[] = [
  { kind: "image", label: "Images", icon: ImageIcon },
  { kind: "video", label: "Videos", icon: Film },
  { kind: "audio", label: "Audio", icon: Music },
  { kind: "document", label: "Documents", icon: FileText },
];
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "folders", label: "Folders" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "document", label: "Documents" },
];
const DOC_KINDS = new Set(["pdf", "doc", "sheet", "slides", "text"]);
const PAGE = 300;

function readView(): View {
  const p = new URLSearchParams(window.location.search);
  const q = p.get("q");
  if (q) return { type: "search", q };
  const v = p.get("view");
  if (v === "recent") return { type: "recent" };
  if (v === "image" || v === "video" || v === "audio" || v === "document") return { type: "kind", kind: v };
  return { type: "folder", id: p.get("f") };
}
function viewUrl(v: View) {
  if (v.type === "search") return `/?q=${encodeURIComponent(v.q)}`;
  if (v.type === "recent") return "/?view=recent";
  if (v.type === "kind") return `/?view=${v.kind}`;
  return v.id ? `/?f=${v.id}` : "/";
}
const sameView = (a: View, b: View) => viewUrl(a) === viewUrl(b);

function store<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const initials = (s: string) =>
  s
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

const isTouch = () => typeof window !== "undefined" && window.matchMedia?.("(hover: none)").matches;

// ---------- component ----------

export default function Drive() {
  const [mounted, setMounted] = useState(false);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [picker, setPicker] = useState<"first" | "settings" | null>(null);

  const [view, setView] = useState<View>({ type: "folder", id: null });
  const [listing, setListing] = useState<Listing | null>(null);
  const [totals, setTotals] = useState<Listing["stats"] | null>(null);
  const [results, setResults] = useState<FileItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const [layout, setLayout] = useState<"list" | "grid">("list");
  const [sort, setSort] = useState<Sort>({ key: "name", dir: 1 });
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[] } | null>(null);
  const [preview, setPreview] = useState<{ files: FileItem[]; index: number } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploadsOpen, setUploadsOpen] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pool, setPool] = useState<Pool | null>(null);
  const [showStorage, setShowStorage] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [dest, setDest] = useState("telegram");
  const [offline, setOffline] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const queue = useRef<Batch[]>([]);
  const pendingByKey = useRef(new Map<string, { item: Pending; target: string | null; dest: string }>());
  const aborts = useRef(new Map<string, AbortController>());
  const cancelled = useRef(new Set<string>());
  const running = useRef(false);
  const dragDepth = useRef(0);
  const anchorKey = useRef<string | null>(null);
  const toastId = useRef(0);
  const loadSeq = useRef(0);

  const design = prefs?.design ?? "nimbus";
  const folderId = view.type === "folder" ? view.id : null;

  // ----- toasts -----
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (kind: Toast["kind"], text: string, opts: { action?: Toast["action"]; sticky?: boolean } = {}) => {
      const id = ++toastId.current;
      setToasts((t) => [...t.slice(-3), { id, kind, text, action: opts.action }]);
      if (kind !== "progress" && !opts.sticky) setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000);
      return id;
    },
    [dismiss],
  );
  const patchToast = (id: number, patch: Partial<Toast>) =>
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const fail = useCallback((e: unknown) => toast("error", msg(e)), [toast]);

  // ----- boot: theme + view from URL -----
  useEffect(() => {
    const p = loadPrefs();
    if (p) {
      setPrefs(p);
      applyPrefs(p);
    } else {
      setPrefs({ design: "nimbus", mode: "system" });
      setPicker("first");
    }
    setView(readView());
    setSort(store<Sort>("tgd_sort", { key: "name", dir: 1 }));
    try {
      const saved = localStorage.getItem("tgd_dest");
      if (saved) setDest(saved);
    } catch {
      /* ignore */
    }
    setOffline(!navigator.onLine);
    setMounted(true);
  }, []);

  // Per-design default layout (Nimbus = table, the others = grid), remembered per design.
  useEffect(() => {
    if (!prefs) return;
    setLayout(store(`tgd_layout_${prefs.design}`, prefs.design === "nimbus" ? "list" : "grid"));
  }, [prefs]);

  // Follow the OS light/dark setting when mode is "system".
  useEffect(() => {
    if (prefs?.mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applyPrefs(prefs);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [prefs]);

  useEffect(() => {
    const on = () => {
      setOffline(false);
      toast("success", "You're back online.");
    };
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [toast]);

  // ----- data loading -----
  const load = useCallback(async (v: View = viewRef.current, quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      if (v.type === "folder") {
        const d = await api<Listing>(`/api/list?folder=${v.id ?? ""}`);
        if (seq !== loadSeq.current) return;
        setListing(d);
        setTotals(d.stats);
        setResults(null);
      } else {
        const qs =
          v.type === "recent" ? "recent=1" : v.type === "kind" ? `type=${v.kind}` : `q=${encodeURIComponent(v.q)}`;
        const r = await api<{ files: FileItem[] }>(`/api/search?${qs}`);
        if (seq !== loadSeq.current) return;
        setResults(r.files);
      }
      setLoadError(null);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(msg(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    setSelected(new Set());
    setLimit(PAGE);
    setFilter("all");
    void load(view);
  }, [view, mounted, load]);

  const loadPool = useCallback(
    async (refresh = false) => {
      try {
        setPool(await api<Pool>(`/api/accounts${refresh ? "?refresh=1" : ""}`));
      } catch (e) {
        if (refresh) fail(e);
      }
    },
    [fail],
  );

  useEffect(() => {
    if (!mounted) return;
    if (viewRef.current.type !== "folder")
      api<Listing>("/api/list?folder=")
        .then((d) => setTotals((t) => t ?? d.stats))
        .catch(() => {});
    void loadPool();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const gerror = params.get("gerror");
    if (connected || gerror) {
      if (connected) toast("success", `Connected ${connected}`);
      if (gerror) toast("error", `Google: ${gerror}`, { sticky: true });
      setShowStorage(true);
      params.delete("connected");
      params.delete("gerror");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `/?${qs}` : "/");
    }
  }, [mounted, loadPool, toast]);

  // If the chosen destination account disappears, fall back to Telegram
  useEffect(() => {
    if (!pool) return;
    const ok =
      dest === "telegram" ||
      (dest === "r2" && pool.r2.configured) ||
      (dest === "gdrive" && pool.google.some((g) => !g.needsReauth)) ||
      pool.google.some((g) => `gdrive:${g.id}` === dest && !g.needsReauth);
    if (!ok) setDest("telegram");
  }, [pool, dest]);

  const chooseDest = (v: string) => {
    setDest(v);
    try {
      localStorage.setItem("tgd_dest", v);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const onPop = () => setView(readView());
    window.addEventListener("popstate", onPop);
    dirInput.current?.setAttribute("webkitdirectory", "");
    return () => window.removeEventListener("popstate", onPop);
  }, [mounted]);

  const navigate = useCallback((v: View) => {
    setSideOpen(false);
    if (v.type !== "search") setQuery("");
    if (sameView(v, viewRef.current)) return void load(v);
    setView(v);
    window.history.pushState(null, "", viewUrl(v));
  }, [load]);
  const openFolder = (id: string | null) => navigate({ type: "folder", id });

  // Search as you type (debounced). Clearing goes back to where you were.
  const lastPlace = useRef<View>({ type: "folder", id: null });
  useEffect(() => {
    if (view.type !== "search") lastPlace.current = view;
  }, [view]);
  useEffect(() => {
    if (!mounted) return;
    const q = query.trim();
    const t = setTimeout(() => {
      if (q) {
        if (viewRef.current.type !== "search" || viewRef.current.q !== q) {
          const v: View = { type: "search", q };
          const replace = viewRef.current.type === "search";
          setView(v);
          window.history[replace ? "replaceState" : "pushState"](null, "", viewUrl(v));
        }
      } else if (viewRef.current.type === "search") {
        navigate(lastPlace.current);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, mounted, navigate]);
  useEffect(() => {
    if (view.type === "search" && view.q !== query.trim()) setQuery(view.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ----- entries (sorted, filtered) -----
  const entries = useMemo<Entry[]>(() => {
    const folders: Entry[] =
      view.type === "folder" && listing
        ? listing.folders.map((f) => ({ key: `d:${f.id}`, type: "folder", id: f.id, name: f.name, date: f.createdAt, size: -1, folder: f }))
        : [];
    const fileList = view.type === "folder" ? (listing?.files ?? []) : (results ?? []);
    const files: Entry[] = fileList.map((f) => ({
      key: `f:${f.id}`,
      type: "file",
      id: f.id,
      name: f.name,
      date: f.createdAt,
      size: f.size,
      file: f,
    }));
    const cmp = (a: Entry, b: Entry) => {
      let r = 0;
      if (sort.key === "name") r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      else if (sort.key === "date") r = new Date(a.date).getTime() - new Date(b.date).getTime();
      else r = a.size - b.size;
      return r * sort.dir || a.name.localeCompare(b.name);
    };
    const keepSorted = view.type === "recent" && sort.key === "name" && sort.dir === 1; // recent = newest first by default
    const matches = (e: Entry) => {
      if (filter === "all") return true;
      if (filter === "folders") return e.type === "folder";
      if (e.type === "folder") return false;
      const k = kindOf(e.file.mime, e.file.name);
      return filter === "document" ? DOC_KINDS.has(k) : k === filter;
    };
    return [...folders.sort(cmp), ...(keepSorted ? files : files.sort(cmp))].filter(matches);
  }, [view.type, listing, results, sort, filter]);

  const shown = entries.slice(0, limit);
  const visibleFiles = useMemo(
    () => entries.filter((e): e is Extract<Entry, { type: "file" }> => e.type === "file").map((e) => e.file),
    [entries],
  );
  const selectedEntries = entries.filter((e) => selected.has(e.key));

  // Infinite scroll: render more when the sentinel becomes visible.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || entries.length <= limit) return;
    const io = new IntersectionObserver((es) => es[0]?.isIntersecting && setLimit((l) => l + PAGE), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [entries.length, limit]);

  // ----- uploads -----
  const patchJob = (key: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  const runQueue = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const batch = queue.current.shift()!;
        const dirCache = new Map<string, string | null>([["", batch.target]]);
        for (let i = 0; i < batch.items.length; i++) {
          const { file, dir } = batch.items[i];
          const key = batch.keys[i];
          if (cancelled.current.has(key)) continue;
          patchJob(key, { status: "uploading", done: 0, error: undefined });
          const ctl = new AbortController();
          aborts.current.set(key, ctl);
          try {
            let parent = dirCache.get(dir);
            if (parent === undefined) {
              const r = await api<{ id: string }>("/api/folders", {
                method: "POST",
                body: JSON.stringify({ parentId: batch.target, path: dir }),
              });
              parent = r.id;
              dirCache.set(dir, parent);
            }
            await uploadFile(file, parent, batch.dest, (n) => patchJob(key, { done: n }), ctl.signal);
            patchJob(key, { status: "done", done: file.size });
            pendingByKey.current.delete(key);
          } catch (e) {
            if (cancelled.current.has(key)) patchJob(key, { status: "cancelled" });
            else patchJob(key, { status: "error", error: msg(e) });
          } finally {
            aborts.current.delete(key);
          }
          const v = viewRef.current;
          if (batch.items.length <= 20 && v.type === "folder" && v.id === batch.target) void load(v, true);
        }
        void load(viewRef.current, true);
        void loadPool();
      }
    } finally {
      running.current = false;
    }
  };

  const enqueue = (items: Pending[], target: string | null = folderId) => {
    if (!items.length) return;
    const stamp = Date.now();
    const newJobs: Job[] = items.map((p, i) => ({
      key: `${stamp}-${i}-${Math.random().toString(36).slice(2)}`,
      label: p.dir ? `${p.dir}/${p.file.name}` : p.file.name,
      name: p.file.name,
      size: p.file.size,
      done: 0,
      status: "queued",
    }));
    newJobs.forEach((j, i) => pendingByKey.current.set(j.key, { item: items[i], target, dest }));
    queue.current.push({ items, keys: newJobs.map((j) => j.key), target, dest });
    setJobs((js) => [...js.filter((j) => j.status !== "cancelled"), ...newJobs]);
    setUploadsOpen(true);
    void runQueue();
  };

  const retryJobs = (keys: string[]) => {
    const groups = new Map<string, { items: Pending[]; keys: string[]; target: string | null; dest: string }>();
    for (const k of keys) {
      const p = pendingByKey.current.get(k);
      if (!p) continue;
      cancelled.current.delete(k);
      const g = groups.get(`${p.target}|${p.dest}`) ?? { items: [], keys: [], target: p.target, dest: p.dest };
      g.items.push(p.item);
      g.keys.push(k);
      groups.set(`${p.target}|${p.dest}`, g);
    }
    for (const g of groups.values()) queue.current.push(g);
    setJobs((js) => js.map((j) => (keys.includes(j.key) ? { ...j, status: "queued", error: undefined, done: 0 } : j)));
    void runQueue();
  };

  const cancelJob = (key: string) => {
    cancelled.current.add(key);
    aborts.current.get(key)?.abort();
    patchJob(key, { status: "cancelled" });
  };

  const activeJobs = jobs.filter((j) => j.status === "queued" || j.status === "uploading");
  const failedJobs = jobs.filter((j) => j.status === "error");

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    if (!activeJobs.length) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [activeJobs.length]);

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    enqueue(list.map((file) => ({ file, dir: "" })));
  };
  const onPickFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    enqueue(
      list.map((file) => {
        const parts = (file.webkitRelativePath || file.name).split("/");
        parts.pop();
        return { file, dir: parts.join("/") };
      }),
    );
  };

  // ----- drag & drop (upload from the PC, or move files onto a folder) -----
  const INTERNAL = "application/x-tgd-files";
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const isInternal = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(INTERNAL);
  const canUploadHere = view.type === "folder";

  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e) || isInternal(e) || !canUploadHere) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (hasFiles(e) && !isInternal(e) && canUploadHere) e.preventDefault();
  };
  const onDragLeave = (e: DragEvent) => {
    if (isInternal(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e) || isInternal(e) || !canUploadHere) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const target = folderId;
    collectDropped(e.dataTransfer)
      .then((items) => enqueue(items, target))
      .catch(fail);
  };

  const startDrag = (e: DragEvent, entry: Entry) => {
    if (entry.type !== "file") return e.preventDefault();
    const keys = selected.has(entry.key) ? selectedEntries.filter((x) => x.type === "file").map((x) => x.id) : [entry.id];
    e.dataTransfer.setData(INTERNAL, JSON.stringify(keys));
    e.dataTransfer.effectAllowed = "move";
  };
  const folderDropProps = (targetId: string | null, key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!isInternal(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((k) => (k === key ? null : k)),
    onDrop: (e: DragEvent) => {
      if (!isInternal(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const ids = JSON.parse(e.dataTransfer.getData(INTERNAL) || "[]") as string[];
      void moveFiles(ids, targetId);
    },
  });

  // ----- actions -----
  const moveFiles = async (ids: string[], target: string | null) => {
    const files = ids.filter((id) => {
      const f = (view.type === "folder" ? listing?.files : results)?.find((x) => x.id === id);
      return !f || f.folderId !== target;
    });
    if (!files.length) return;
    const t = toast("progress", `Moving ${files.length} item${files.length === 1 ? "" : "s"}…`);
    let failed = 0;
    for (const id of files) {
      try {
        await api(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ folderId: target }) });
      } catch {
        failed++;
      }
    }
    dismiss(t);
    if (failed) toast("error", `${failed} item${failed === 1 ? "" : "s"} couldn't be moved.`);
    else toast("success", `Moved ${files.length} item${files.length === 1 ? "" : "s"}.`);
    setSelected(new Set());
    void load(viewRef.current, true);
  };

  const download = async (files: FileItem[]) => {
    const ready = files.filter((f) => f.status === "ready");
    if (!ready.length) return toast("error", "Those files haven't finished uploading yet.");
    for (const f of ready) {
      const t = toast("progress", `Downloading ${f.name}…`);
      try {
        await downloadFile(f, (pct, name) => patchToast(t, { text: `Downloading ${name}`, progress: pct }));
        dismiss(t);
      } catch (e) {
        dismiss(t);
        toast("error", `${f.name}: ${msg(e)}`, { action: { label: "Retry", run: () => void download([f]) } });
      }
    }
  };

  const doDelete = async (list: Entry[]) => {
    let failed = 0;
    for (const e of list) {
      try {
        await api(`/api/${e.type === "folder" ? "folders" : "files"}/${e.id}`, { method: "DELETE" });
      } catch (err) {
        failed++;
        if (list.length === 1) throw err;
      }
    }
    setSelected(new Set());
    void load(viewRef.current, true);
    void loadPool();
    if (failed) toast("error", `${failed} item${failed === 1 ? "" : "s"} couldn't be deleted.`);
    else toast("success", list.length === 1 ? `Deleted “${list[0].name}”.` : `Deleted ${list.length} items.`);
  };

  const logout = async () => {
    if (activeJobs.length && !window.confirm("Uploads are still running. Log out anyway?")) return;
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const disconnect = async (a: GoogleAccount) => {
    if (!window.confirm(`Disconnect ${a.email}?`)) return;
    try {
      await api(`/api/accounts/${a.id}`, { method: "DELETE" });
      await loadPool();
    } catch (e) {
      fail(e);
    }
  };

  const open = (e: Entry) => {
    if (e.type === "folder") return openFolder(e.id);
    const i = visibleFiles.findIndex((f) => f.id === e.id);
    setPreview({ files: visibleFiles, index: Math.max(0, i) });
  };

  // ----- selection -----
  const select = (e: Entry, ev: ReactMouseEvent | ReactKeyboardEvent) => {
    const multi = ev.ctrlKey || ev.metaKey;
    if (ev.shiftKey && anchorKey.current) {
      const a = entries.findIndex((x) => x.key === anchorKey.current);
      const b = entries.findIndex((x) => x.key === e.key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = entries.slice(lo, hi + 1).map((x) => x.key);
        setSelected((s) => new Set(multi ? [...s, ...range] : range));
        return;
      }
    }
    anchorKey.current = e.key;
    setSelected((s) => {
      if (multi) {
        const n = new Set(s);
        if (n.has(e.key)) n.delete(e.key);
        else n.add(e.key);
        return n;
      }
      return new Set([e.key]);
    });
  };
  const toggle = (e: Entry) => {
    anchorKey.current = e.key;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(e.key)) n.delete(e.key);
      else n.add(e.key);
      return n;
    });
  };
  const onItemClick = (e: Entry, ev: ReactMouseEvent) => {
    if (isTouch() && !selected.size) return open(e);
    if (isTouch()) return toggle(e);
    select(e, ev);
  };

  const itemMenu = (e: Entry): MenuItem[] => {
    const many = selected.has(e.key) && selected.size > 1;
    const targets = many ? selectedEntries : [e];
    const files = targets.filter((x): x is Extract<Entry, { type: "file" }> => x.type === "file").map((x) => x.file);
    if (many)
      return [
        { label: `Download ${files.length} file${files.length === 1 ? "" : "s"}`, icon: Download, onSelect: () => void download(files), disabled: !files.length },
        { label: "Move to…", icon: FolderInput, onSelect: () => setDialog({ kind: "move", files }), disabled: !files.length || targets.some((t) => t.type === "folder") },
        "separator",
        { label: `Delete ${targets.length} items`, icon: Trash2, danger: true, onSelect: () => setDialog({ kind: "delete", entries: targets }), shortcut: "Del" },
      ];
    const items: MenuItem[] = [
      { label: e.type === "folder" ? "Open" : "Preview", icon: e.type === "folder" ? FolderOpen : Eye, onSelect: () => open(e), shortcut: "Enter" },
    ];
    if (e.type === "file") {
      items.push({ label: "Download", icon: Download, onSelect: () => void download([e.file]), disabled: e.file.status !== "ready" });
      if (view.type !== "folder")
        items.push({ label: "Show in folder", icon: FolderOpen, onSelect: () => openFolder(e.file.folderId) });
    }
    items.push("separator", { label: "Rename", icon: Pencil, onSelect: () => setDialog({ kind: "rename", entry: e }), shortcut: "F2" });
    if (e.type === "file") items.push({ label: "Move to…", icon: FolderInput, onSelect: () => setDialog({ kind: "move", files: [e.file] }) });
    items.push("separator", { label: "Delete", icon: Trash2, danger: true, onSelect: () => setDialog({ kind: "delete", entries: [e] }), shortcut: "Del" });
    return items;
  };
  const showMenu = (e: Entry, anchor: MenuAnchor) => {
    if (!selected.has(e.key)) {
      anchorKey.current = e.key;
      setSelected(new Set([e.key]));
    }
    setMenu({ anchor, items: itemMenu(e) });
  };
  const onContext = (e: Entry, ev: ReactMouseEvent) => {
    ev.preventDefault();
    showMenu(e, { x: ev.clientX, y: ev.clientY });
  };
  const onKebab = (e: Entry, ev: ReactMouseEvent<HTMLButtonElement>) => {
    ev.stopPropagation();
    const r = ev.currentTarget.getBoundingClientRect();
    showMenu(e, { x: r.right, y: r.bottom + 4, alignRight: true });
  };
  const newMenu = (ev: ReactMouseEvent<HTMLButtonElement>, alignRight = false) => {
    const r = ev.currentTarget.getBoundingClientRect();
    setMenu({
      anchor: { x: alignRight ? r.right : r.left, y: r.bottom + 6, alignRight },
      items: [
        { label: "New folder", icon: FolderPlus, onSelect: () => setDialog({ kind: "newFolder" }) },
        "separator",
        { label: "Upload files", icon: Upload, onSelect: () => fileInput.current?.click() },
        { label: "Upload folder", icon: FolderUp, onSelect: () => dirInput.current?.click() },
      ],
    });
  };
  const sortMenu = (ev: ReactMouseEvent<HTMLButtonElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const opt = (key: SortKey, label: string): MenuItem => ({
      label,
      icon: sort.key === key ? Check : undefined,
      onSelect: () => setSortKey(key),
    });
    setMenu({
      anchor: { x: r.right, y: r.bottom + 6, alignRight: true },
      items: [
        opt("name", "Name"),
        opt("date", "Date added"),
        opt("size", "Size"),
        "separator",
        { label: sort.dir === 1 ? "Ascending" : "Descending", icon: sort.dir === 1 ? ArrowUp : ArrowDown, onSelect: () => setSortKey(sort.key, true) },
      ],
    });
  };
  const setSortKey = (key: SortKey, flip = false) => {
    const next: Sort = flip || sort.key === key ? { key, dir: (sort.dir * -1) as 1 | -1 } : { key, dir: key === "name" ? 1 : -1 };
    setSort(next);
    keep("tgd_sort", next);
  };
  const setLayoutKeep = (l: "list" | "grid") => {
    setLayout(l);
    keep(`tgd_layout_${design}`, l);
  };

  // ----- keyboard shortcuts -----
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (dialog || preview || menu || picker || showStorage || showDevices) return;
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.key)));
      } else if (e.key === "Escape" && selected.size) {
        setSelected(new Set());
      } else if (e.key === "Delete" && selectedEntries.length) {
        setDialog({ kind: "delete", entries: selectedEntries });
      } else if (e.key === "F2" && selectedEntries.length === 1) {
        e.preventDefault();
        setDialog({ kind: "rename", entry: selectedEntries[0] });
      } else if (e.key === "Backspace" && e.altKey === false && view.type === "folder" && listing?.breadcrumbs.length) {
        const c = listing.breadcrumbs;
        openFolder(c.length > 1 ? c[c.length - 2].id : null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // ----- render helpers -----
  if (!mounted || !prefs) return <div className="bootSplash" aria-busy="true" />;

  if (picker === "first")
    return (
      <ThemePicker
        firstRun
        initial={prefs}
        onDone={(p) => {
          savePrefs(p);
          setPrefs(p);
          applyPrefs(p);
          setPicker(null);
        }}
      />
    );

  const crumbs = listing && view.type === "folder" ? listing.breadcrumbs : [];
  const placeName =
    view.type === "folder"
      ? crumbs.length
        ? crumbs[crumbs.length - 1].name
        : "My Drive"
      : view.type === "recent"
        ? "Recent"
        : view.type === "kind"
          ? KIND_VIEWS.find((k) => k.kind === view.kind)!.label
          : `Results for “${view.q}”`;
  const userName = pool ? pool.user.name || pool.user.email.split("@")[0] : "";
  const stats = totals;
  const isEmpty = !loading && !loadError && entries.length === 0;
  const showLocation = view.type !== "folder";

  const navItems: { label: string; icon: LucideIcon; view: View; active: boolean }[] = [
    { label: "My Drive", icon: HardDrive, view: { type: "folder", id: null }, active: view.type === "folder" },
    { label: "Recent", icon: Clock, view: { type: "recent" }, active: view.type === "recent" },
    ...KIND_VIEWS.map((k) => ({
      label: k.label,
      icon: k.icon,
      view: { type: "kind", kind: k.kind } as View,
      active: view.type === "kind" && view.kind === k.kind,
    })),
  ];

  const newButton = (big = false) => (
    <button type="button" className={`btn primary newBtn ${big ? "big" : ""}`} onClick={(e) => newMenu(e, !big)} aria-haspopup="menu">
      <Plus size={big ? 22 : 17} aria-hidden /> <span>New</span>
    </button>
  );

  const storageCard = (
    <div className="storageCard">
      <div className="storageTop">
        <span className="storageTitle">
          <Cloud size={16} aria-hidden /> Storage
        </span>
        {stats && <span className="muted small">{stats.files.toLocaleString()} files</span>}
      </div>
      <div className="storageBig">{stats ? formatBytes(stats.bytes) : "—"} stored</div>
      {pool?.r2.configured && (
        <>
          <div className="meter" role="meter" aria-label="Cloudflare R2 used" aria-valuemin={0} aria-valuemax={pool.r2.limit} aria-valuenow={pool.r2.used}>
            <div style={{ width: `${Math.min(100, (pool.r2.used / Math.max(1, pool.r2.limit)) * 100)}%` }} />
          </div>
          <div className="muted small">
            R2: {formatBytes(pool.r2.used)} of {formatBytes(pool.r2.limit)} · Telegram: no limit
          </div>
        </>
      )}
      <button type="button" className="linkBtn small" onClick={() => setShowStorage(true)}>
        Manage storage
      </button>
    </div>
  );

  const sidebar = (
    <aside className={`side ${sideOpen ? "open" : ""}`} aria-label="Navigation">
      <div className="sideHead">
        {design === "nimbus" ? (
          <div className="account" title={pool?.user.email}>
            <span className="avatar">{initials(userName || "TG")}</span>
            <span className="accountText">
              <strong>{userName || "TG Drive"}</strong>
              <span className="muted small">{pool?.user.email ?? "Loading…"}</span>
            </span>
          </div>
        ) : (
          <button type="button" className="brand" onClick={() => openFolder(null)}>
            <span className="brandMark" aria-hidden>
              <HardDrive size={18} />
            </span>
            <span>TG Drive</span>
          </button>
        )}
        <IconButton icon={X} label="Close menu" className="sideClose" onClick={() => setSideOpen(false)} />
      </div>
      {design === "classic" && <div className="sideNew">{newButton(true)}</div>}
      <nav className="sideNav">
        {design === "conferio" && <div className="navGroup">Drive views</div>}
        {navItems.map((n, i) => (
          <div key={n.label}>
            {i === 2 && design !== "conferio" && <div className="navGroup">Types</div>}
            <button
              type="button"
              className={`navItem ${n.active ? "on" : ""} ${n.label === "My Drive" && dropTarget === "nav-root" ? "dropOn" : ""}`}
              aria-current={n.active ? "page" : undefined}
              onClick={() => navigate(n.view)}
              {...(n.label === "My Drive" ? folderDropProps(null, "nav-root") : {})}
            >
              <n.icon size={18} aria-hidden />
              <span>{n.label}</span>
            </button>
          </div>
        ))}
        <div className="navGroup">This PC & storage</div>
        <button type="button" className="navItem" onClick={() => setShowDevices(true)}>
          <Monitor size={18} aria-hidden />
          <span>PC drive (T:)</span>
        </button>
        <button type="button" className="navItem" onClick={() => setShowStorage(true)}>
          <Cloud size={18} aria-hidden />
          <span>Storage pool</span>
        </button>
      </nav>
      <div className="sideFoot">
        {storageCard}
        <button type="button" className="navItem" onClick={() => setPicker("settings")}>
          <Palette size={18} aria-hidden />
          <span>Appearance</span>
          <span className="navHint">{DESIGN_INFO[design].name}</span>
        </button>
        <button type="button" className="navItem" onClick={logout}>
          <LogOut size={18} aria-hidden />
          <span>Log out</span>
        </button>
      </div>
    </aside>
  );

  const rail = design === "conferio" && (
    <nav className="rail" aria-label="Quick navigation">
      <button type="button" className="railBrand" onClick={() => openFolder(null)} aria-label="TG Drive home">
        <HardDrive size={20} aria-hidden />
      </button>
      {[
        { icon: Home, label: "My Drive", v: { type: "folder", id: null } as View, on: view.type === "folder" },
        { icon: Clock, label: "Recent", v: { type: "recent" } as View, on: view.type === "recent" },
        { icon: ImageIcon, label: "Images", v: { type: "kind", kind: "image" } as View, on: view.type === "kind" && view.kind === "image" },
        { icon: Film, label: "Videos", v: { type: "kind", kind: "video" } as View, on: view.type === "kind" && view.kind === "video" },
      ].map((r) => (
        <IconButton key={r.label} icon={r.icon} label={r.label} active={r.on} onClick={() => navigate(r.v)} className="railBtn" />
      ))}
      <div className="railSpacer" />
      <IconButton icon={Monitor} label="PC drive" onClick={() => setShowDevices(true)} className="railBtn" />
      <IconButton icon={Palette} label="Appearance" onClick={() => setPicker("settings")} className="railBtn" />
      <button type="button" className="railAvatar" title={pool?.user.email} onClick={logout} aria-label="Log out">
        {initials(userName || "TG")}
      </button>
    </nav>
  );

  const searchBox = (
    <form className="searchBox" role="search" onSubmit={(e) => e.preventDefault()}>
      <Search size={18} aria-hidden className="searchIcon" />
      <input
        ref={searchRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && (setQuery(""), (e.target as HTMLInputElement).blur())}
        placeholder="Search in Drive"
        aria-label="Search files"
        type="search"
      />
      {query ? (
        <IconButton icon={X} label="Clear search" size={16} onClick={() => setQuery("")} />
      ) : (
        <kbd className="searchKbd" aria-hidden>
          /
        </kbd>
      )}
    </form>
  );

  const breadcrumbs = (
    <nav className="crumbs" aria-label="Folder path">
      {view.type === "folder" ? (
        <>
          <button
            type="button"
            className={`crumb ${crumbs.length ? "" : "here"} ${dropTarget === "crumb-root" ? "dropOn" : ""}`}
            onClick={() => openFolder(null)}
            {...folderDropProps(null, "crumb-root")}
          >
            {design === "nimbus" ? <Home size={16} aria-label="My Drive" /> : "My Drive"}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="crumbPart">
              <ChevronRight size={16} aria-hidden className="crumbSep" />
              <button
                type="button"
                className={`crumb ${i === crumbs.length - 1 ? "here" : ""} ${dropTarget === `crumb-${c.id}` ? "dropOn" : ""}`}
                onClick={() => openFolder(c.id)}
                aria-current={i === crumbs.length - 1 ? "page" : undefined}
                {...folderDropProps(c.id, `crumb-${c.id}`)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </>
      ) : (
        <span className="crumb here">{placeName}</span>
      )}
      {loading && <Loader2 size={16} className="spin muted" aria-label="Loading" />}
    </nav>
  );

  const toolbar =
    selected.size > 0 ? (
      <div className="toolbar selBar" role="toolbar" aria-label="Selection actions">
        <IconButton icon={X} label="Clear selection" onClick={() => setSelected(new Set())} />
        <strong>{selected.size} selected</strong>
        <div className="toolSpacer" />
        {(() => {
          const files = selectedEntries.filter((x): x is Extract<Entry, { type: "file" }> => x.type === "file").map((x) => x.file);
          const hasFolder = selectedEntries.some((x) => x.type === "folder");
          return (
            <>
              <IconButton icon={Download} label="Download" disabled={!files.length} onClick={() => void download(files)} />
              <IconButton icon={FolderInput} label="Move to…" disabled={!files.length || hasFolder} onClick={() => setDialog({ kind: "move", files })} />
              {selectedEntries.length === 1 && (
                <IconButton icon={Pencil} label="Rename" onClick={() => setDialog({ kind: "rename", entry: selectedEntries[0] })} />
              )}
              <IconButton icon={Trash2} label="Delete" className="danger" onClick={() => setDialog({ kind: "delete", entries: selectedEntries })} />
            </>
          );
        })()}
      </div>
    ) : (
      <div className="toolbar">
        {breadcrumbs}
        <div className="toolSpacer" />
        <button type="button" className="btn ghost sm sortBtn" onClick={sortMenu} aria-haspopup="menu">
          {sort.dir === 1 ? <ArrowUp size={15} aria-hidden /> : <ArrowDown size={15} aria-hidden />}
          {sort.key === "name" ? "Name" : sort.key === "date" ? "Date added" : "Size"}
        </button>
        <div className="segmented sm" role="group" aria-label="Layout">
          <button type="button" className={layout === "list" ? "on" : ""} aria-pressed={layout === "list"} onClick={() => setLayoutKeep("list")} aria-label="List view" title="List view">
            <List size={16} aria-hidden />
          </button>
          <button type="button" className={layout === "grid" ? "on" : ""} aria-pressed={layout === "grid"} onClick={() => setLayoutKeep("grid")} aria-label="Grid view" title="Grid view">
            <LayoutGrid size={16} aria-hidden />
          </button>
        </div>
      </div>
    );

  const chips = view.type === "folder" && (listing?.files.length || listing?.folders.length) ? (
    <div className="chips" role="group" aria-label="Filter by type">
      {FILTERS.map((f) => (
        <button key={f.value} type="button" className={`chip ${filter === f.value ? "on" : ""}`} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
          {filter === f.value && f.value !== "all" && <Check size={14} aria-hidden />}
          {f.label}
        </button>
      ))}
    </div>
  ) : null;

  const whereBadge = (f: FileItem) => (
    <span className={`where ${f.backend}`} title={f.account ?? (f.backend === "r2" ? "Cloudflare R2" : f.backend === "gdrive" ? "Google Drive" : "Telegram")}>
      {f.backend === "gdrive" ? "Drive" : f.backend === "r2" ? "R2" : "TG"}
    </span>
  );

  const itemProps = (e: Entry) => ({
    "data-key": e.key,
    tabIndex: 0,
    "aria-selected": selected.has(e.key),
    draggable: e.type === "file",
    onDragStart: (ev: DragEvent) => startDrag(ev, e),
    onClick: (ev: ReactMouseEvent) => onItemClick(e, ev),
    onDoubleClick: () => open(e),
    onContextMenu: (ev: ReactMouseEvent) => onContext(e, ev),
    onKeyDown: (ev: ReactKeyboardEvent) => {
      if (ev.key === "Enter") open(e);
      else if (ev.key === " ") {
        ev.preventDefault();
        toggle(e);
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        const all = Array.from(document.querySelectorAll<HTMLElement>("[data-key]"));
        const i = all.indexOf(ev.currentTarget as HTMLElement);
        const cols = layout === "grid" ? Math.max(1, Math.round((ev.currentTarget.parentElement?.clientWidth ?? 1) / ev.currentTarget.clientWidth)) : 1;
        const step = ev.key === "ArrowDown" ? cols : ev.key === "ArrowUp" ? -cols : ev.key === "ArrowRight" ? 1 : -1;
        const next = all[i + step];
        if (next) {
          ev.preventDefault();
          next.focus();
          if (ev.shiftKey) {
            const k = next.dataset.key!;
            setSelected((s) => new Set([...s, k]));
          }
        }
      } else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
        ev.preventDefault();
        const r = ev.currentTarget.getBoundingClientRect();
        showMenu(e, { x: r.left + 24, y: r.top + r.height / 2 });
      }
    },
    ...(e.type === "folder" ? folderDropProps(e.id, e.key) : {}),
  });

  const checkbox = (e: Entry) => (
    <button
      type="button"
      className={`check ${selected.has(e.key) ? "on" : ""}`}
      role="checkbox"
      aria-checked={selected.has(e.key)}
      aria-label={`Select ${e.name}`}
      onClick={(ev) => {
        ev.stopPropagation();
        toggle(e);
      }}
      onDoubleClick={(ev) => ev.stopPropagation()}
    >
      {selected.has(e.key) && <Check size={13} strokeWidth={3} aria-hidden />}
    </button>
  );

  const kebab = (e: Entry) => (
    <button type="button" className="iconBtn kebab" aria-label={`More actions for ${e.name}`} aria-haspopup="menu" onClick={(ev) => onKebab(e, ev)} onDoubleClick={(ev) => ev.stopPropagation()}>
      <MoreVertical size={18} aria-hidden />
    </button>
  );

  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.key));
  const sortHead = (key: SortKey, label: string, cls: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="thBtn" onClick={() => setSortKey(key)}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />)}
      </button>
    </th>
  );

  const listView = (
    <div className="tableWrap">
      <table className="fileTable">
        <thead>
          <tr>
            <th className="cCheck">
              <button
                type="button"
                className={`check ${allSelected ? "on" : ""}`}
                role="checkbox"
                aria-checked={allSelected}
                aria-label="Select all"
                onClick={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.key)))}
              >
                {allSelected && <Check size={13} strokeWidth={3} aria-hidden />}
              </button>
            </th>
            {sortHead("name", "Name", "cName")}
            {showLocation && <th className="cLoc">Location</th>}
            {sortHead("date", "Date added", "cDate")}
            {sortHead("size", "Size", "cSize")}
            <th className="cWhere">Stored in</th>
            <th className="cAct">
              <span className="sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.key} className={`row ${selected.has(e.key) ? "sel" : ""} ${dropTarget === e.key ? "dropOn" : ""}`} {...itemProps(e)}>
              <td className="cCheck">{checkbox(e)}</td>
              <td className="cName">
                <span className="nameCell">
                  {e.type === "folder" ? <KindIcon kind="folder" /> : <FileTypeIcon mime={e.file.mime} name={e.name} />}
                  <span className="nameText" title={e.name}>
                    {e.name}
                  </span>
                  {e.type === "file" && e.file.status !== "ready" && <span className="badge warn">Incomplete</span>}
                </span>
              </td>
              {showLocation && (
                <td className="cLoc">
                  {e.type === "file" && (
                    <button
                      type="button"
                      className="linkBtn small"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        openFolder(e.file.folderId);
                      }}
                    >
                      <FolderOpen size={14} aria-hidden /> Open folder
                    </button>
                  )}
                </td>
              )}
              <td className="cDate">{formatDate(e.date)}</td>
              <td className="cSize">{e.type === "folder" ? "—" : formatBytes(e.size)}</td>
              <td className="cWhere">{e.type === "file" ? whereBadge(e.file) : null}</td>
              <td className="cAct">{kebab(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const folderEntries = shown.filter((e) => e.type === "folder");
  const fileEntries = shown.filter((e) => e.type === "file");
  const gridView = (
    <div className="gridWrap">
      {folderEntries.length > 0 && (
        <section aria-label="Folders">
          <h3 className="sectionTitle">Folders</h3>
          <div className="folderGrid">
            {folderEntries.map((e) => (
              <div key={e.key} className={`folderCard ${selected.has(e.key) ? "sel" : ""} ${dropTarget === e.key ? "dropOn" : ""}`} {...itemProps(e)}>
                {checkbox(e)}
                <KindIcon kind="folder" size={22} />
                <span className="nameText" title={e.name}>
                  {e.name}
                </span>
                {kebab(e)}
              </div>
            ))}
          </div>
        </section>
      )}
      {fileEntries.length > 0 && (
        <section aria-label="Files">
          {folderEntries.length > 0 && <h3 className="sectionTitle">Files</h3>}
          <div className="fileGrid">
            {fileEntries.map((e) => {
              const f = (e as Extract<Entry, { type: "file" }>).file;
              return (
                <div key={e.key} className={`fileCard ${selected.has(e.key) ? "sel" : ""}`} {...itemProps(e)}>
                  <div className="cardHead">
                    <FileTypeIcon mime={f.mime} name={f.name} size={17} />
                    <span className="nameText" title={f.name}>
                      {f.name}
                    </span>
                    {kebab(e)}
                  </div>
                  <div className="thumb">
                    {canThumb(f) ? <Thumb file={f} /> : <KindTile mime={f.mime} name={f.name} />}
                    {checkbox(e)}
                    {f.status !== "ready" && <span className="badge warn thumbBadge">Incomplete</span>}
                  </div>
                  <div className="cardMeta">
                    <span>{formatBytes(f.size)}</span>
                    <span>·</span>
                    <span>{formatDate(f.createdAt)}</span>
                    {whereBadge(f)}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );

  const skeleton = (
    <div className={layout === "grid" ? "skelGrid" : "skelList"} aria-hidden>
      {Array.from({ length: layout === "grid" ? 10 : 8 }, (_, i) => (
        <div key={i} className="skel" style={{ animationDelay: `${i * 60}ms` }} />
      ))}
    </div>
  );

  const emptyState = () => {
    if (view.type === "search")
      return (
        <div className="empty">
          <Search size={44} aria-hidden />
          <h3>No files match “{view.q}”</h3>
          <p className="muted">Try a different word, or check the spelling.</p>
        </div>
      );
    if (view.type !== "folder")
      return (
        <div className="empty">
          <KindIcon kind={view.type === "recent" ? "other" : view.kind === "document" ? "doc" : view.kind} size={44} />
          <h3>{view.type === "recent" ? "Nothing uploaded yet" : `No ${placeName.toLowerCase()} yet`}</h3>
          <p className="muted">Files you upload will show up here.</p>
        </div>
      );
    if (filter !== "all")
      return (
        <div className="empty">
          <h3>No {FILTERS.find((f) => f.value === filter)!.label.toLowerCase()} in this folder</h3>
          <button type="button" className="btn" onClick={() => setFilter("all")}>
            Show everything
          </button>
        </div>
      );
    return (
      <button type="button" className="empty drop" onClick={() => fileInput.current?.click()}>
        <span className="emptyArt" aria-hidden>
          <Upload size={30} />
        </span>
        <h3>{crumbs.length ? "This folder is empty" : "Welcome to your drive"}</h3>
        <p className="muted">Drag files or whole folders here, or click to choose files.</p>
      </button>
    );
  };

  const errorState = (
    <div className="empty errorState" role="alert">
      <WifiOff size={40} aria-hidden />
      <h3>Couldn&apos;t load {placeName}</h3>
      <p className="muted">{loadError}</p>
      <button type="button" className="btn primary" onClick={() => void load()}>
        <RotateCw size={16} aria-hidden /> Try again
      </button>
    </div>
  );

  const content = loadError && !entries.length ? errorState : loading && !entries.length ? skeleton : isEmpty ? emptyState() : layout === "list" ? listView : gridView;

  return (
    <div
      className="shell"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {rail}
      {sidebar}
      {sideOpen && <div className="sideBack" onClick={() => setSideOpen(false)} aria-hidden />}

      <main className="main" aria-label={placeName}>
        <header className="topbar">
          <IconButton icon={MenuIcon} label="Open menu" className="menuBtn" onClick={() => setSideOpen(true)} />
          {design === "classic" && (
            <button type="button" className="brand topBrand" onClick={() => openFolder(null)}>
              <span className="brandMark" aria-hidden>
                <HardDrive size={18} />
              </span>
              <span>TG Drive</span>
            </button>
          )}
          {searchBox}
          <div className="topActions">
            <label className="destPick" title="Where new uploads are stored">
              <span className="sr">Save new uploads to</span>
              <Cloud size={16} aria-hidden />
              <select value={dest} onChange={(e) => chooseDest(e.target.value)}>
                <option value="telegram">Telegram</option>
                {pool?.r2.configured && <option value="r2">Cloudflare R2 ({formatBytes(pool.r2.free)} free)</option>}
                {pool && pool.google.some((g) => !g.needsReauth) && <option value="gdrive">Google Drive (most free)</option>}
                {pool?.google
                  .filter((g) => !g.needsReauth)
                  .map((g) => (
                    <option key={g.id} value={`gdrive:${g.id}`}>
                      {g.email} ({g.free == null ? "unlimited" : `${formatBytes(g.free)} free`})
                    </option>
                  ))}
              </select>
            </label>
            {design !== "classic" && newButton()}
            {design === "classic" && (
              <span className="avatar" title={pool?.user.email}>
                {initials(userName || "TG")}
              </span>
            )}
          </div>
        </header>

        {offline && (
          <div className="banner warn" role="status">
            <WifiOff size={16} aria-hidden /> You&apos;re offline. Changes will fail until you reconnect.
          </div>
        )}

        <div className="panel">
          {toolbar}
          {chips}
          {loadError && entries.length > 0 && (
            <div className="banner error" role="alert">
              {loadError}
              <button type="button" className="linkBtn" onClick={() => void load()}>
                Retry
              </button>
            </div>
          )}
          <div className={`content ${loading && entries.length ? "refreshing" : ""}`}>
            {content}
            {entries.length > limit && <div ref={sentinel} className="sentinel" />}
          </div>
          {view.type === "folder" && stats && (
            <footer className="statusBar muted">
              {entries.length} item{entries.length === 1 ? "" : "s"} here · {stats.files.toLocaleString()} files, {formatBytes(stats.bytes)} in total
            </footer>
          )}
        </div>
      </main>

      <input ref={fileInput} type="file" multiple hidden onChange={onPickFiles} />
      <input ref={dirInput} type="file" multiple hidden onChange={onPickFolder} />

      {jobs.length > 0 && (
        <aside className={`uploads ${uploadsOpen ? "" : "collapsed"}`} aria-label="Uploads">
          <div className="uploadsHead">
            <strong>
              {activeJobs.length
                ? `Uploading ${activeJobs.length} item${activeJobs.length === 1 ? "" : "s"}`
                : failedJobs.length
                  ? `${failedJobs.length} upload${failedJobs.length === 1 ? "" : "s"} failed`
                  : `${jobs.filter((j) => j.status === "done").length} upload${jobs.filter((j) => j.status === "done").length === 1 ? "" : "s"} complete`}
            </strong>
            {failedJobs.length > 0 && (
              <button type="button" className="linkBtn small" onClick={() => retryJobs(failedJobs.map((j) => j.key))}>
                Retry all
              </button>
            )}
            <IconButton icon={uploadsOpen ? ChevronDown : ChevronUp} label={uploadsOpen ? "Collapse" : "Expand"} onClick={() => setUploadsOpen((o) => !o)} />
            {!activeJobs.length && <IconButton icon={X} label="Close" onClick={() => setJobs([])} />}
          </div>
          {uploadsOpen && (
            <ul>
              {jobs.slice(-200).map((j) => {
                const pct = Math.round((j.done / Math.max(1, j.size)) * 100);
                return (
                  <li key={j.key} className={`job ${j.status}`}>
                    <FileTypeIcon mime="" name={j.name} />
                    <div className="jobMain">
                      <div className="jobName" title={j.label}>
                        {j.label}
                      </div>
                      {j.status === "uploading" && (
                        <div className="meter thin">
                          <div style={{ width: `${pct}%` }} />
                        </div>
                      )}
                      {j.error && <div className="jobError">{j.error}</div>}
                    </div>
                    <span className="jobState">
                      {j.status === "done" ? (
                        <Check size={18} className="ok" aria-label="Done" />
                      ) : j.status === "error" ? (
                        <button type="button" className="linkBtn small" onClick={() => retryJobs([j.key])}>
                          Retry
                        </button>
                      ) : j.status === "cancelled" ? (
                        <span className="muted small">Cancelled</span>
                      ) : j.status === "queued" ? (
                        <span className="muted small">Waiting</span>
                      ) : (
                        <span className="small">{pct}%</span>
                      )}
                    </span>
                    {(j.status === "queued" || j.status === "uploading") && (
                      <IconButton icon={X} label={`Cancel ${j.name}`} size={15} onClick={() => cancelJob(j.key)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      )}

      <Toasts toasts={toasts} dismiss={dismiss} />

      {menu && <Menu anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />}

      {preview && (
        <Preview
          files={preview.files}
          index={preview.index}
          onIndex={(index) => setPreview((p) => (p ? { ...p, index } : p))}
          onClose={() => setPreview(null)}
          onDownload={(f) => void download([f])}
        />
      )}

      {dialog?.kind === "newFolder" && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          initial="Untitled folder"
          confirmText="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api("/api/folders", { method: "POST", body: JSON.stringify({ parentId: folderId, name }) });
            await load(viewRef.current, true);
            toast("success", `Created “${name}”.`);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <PromptDialog
          title={`Rename ${dialog.entry.type}`}
          label="New name"
          initial={dialog.entry.name}
          selectBase={dialog.entry.type === "file"}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const e = dialog.entry;
            await api(`/api/${e.type === "folder" ? "folders" : "files"}/${e.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
            await load(viewRef.current, true);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={dialog.entries.length === 1 ? `Delete “${dialog.entries[0].name}”?` : `Delete ${dialog.entries.length} items?`}
          body={
            <p>
              {dialog.entries.some((e) => e.type === "folder")
                ? "Folders are deleted with everything inside them. "
                : ""}
              This can&apos;t be undone.
            </p>
          }
          onClose={() => setDialog(null)}
          onConfirm={() => doDelete(dialog.entries)}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveDialog
          count={dialog.files.length}
          start={view.type === "folder" ? view.id : null}
          onClose={() => setDialog(null)}
          onMove={(target) => moveFiles(dialog.files.map((f) => f.id), target)}
        />
      )}

      {picker === "settings" && (
        <ThemePicker
          initial={prefs}
          onCancel={() => setPicker(null)}
          onDone={(p) => {
            savePrefs(p);
            setPrefs(p);
            applyPrefs(p);
            setPicker(null);
            toast("success", `Switched to ${DESIGN_INFO[p.design].name}.`);
          }}
        />
      )}

      {showStorage && (
        <Modal title={`Storage pool${pool ? ` · ${pool.user.email}` : ""}`} onClose={() => setShowStorage(false)} wide>
          {pool ? <StoragePool pool={pool} onDisconnect={disconnect} onRefresh={() => loadPool(true)} /> : <p className="muted">Loading…</p>}
        </Modal>
      )}

      {showDevices && <DevicesModal onClose={() => setShowDevices(false)} />}

      {dragging && (
        <div className="dropOverlay" aria-hidden>
          <div>
            <Upload size={28} />
            <span>
              Drop to upload to <strong>{placeName}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- pieces ----------

function Thumb({ file }: { file: FileItem }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  if (state === "error") return <KindTile mime={file.mime} name={file.name} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`thumbImg ${state}`}
      src={contentUrl(file.id)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setState("ok")}
      onError={() => setState("error")}
    />
  );
}

function MoveDialog({
  count,
  start,
  onClose,
  onMove,
}: {
  count: number;
  start: string | null;
  onClose: () => void;
  onMove: (target: string | null) => Promise<void>;
}) {
  const [at, setAt] = useState<string | null>(start);
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api<Listing>(`/api/list?folder=${at ?? ""}`)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(msg(e)));
    return () => {
      live = false;
    };
  }, [at]);

  const crumbs = data?.breadcrumbs ?? [];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null;
  return (
    <Modal
      title={`Move ${count} item${count === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <div className="modalActions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || at === start || !!error}
            onClick={async () => {
              setBusy(true);
              await onMove(at);
              onClose();
            }}
          >
            {busy && <Loader2 size={16} className="spin" aria-hidden />}
            Move here
          </button>
        </div>
      }
    >
      <div className="movePath">
        {crumbs.length > 0 && <IconButton icon={ChevronUp} label="Up one level" onClick={() => setAt(parent)} />}
        <strong>{crumbs.length ? crumbs[crumbs.length - 1].name : "My Drive"}</strong>
      </div>
      <div className="moveList" role="listbox" aria-label="Folders">
        {error ? (
          <p className="fieldError">{error}</p>
        ) : !data ? (
          <div className="muted small pad">
            <Loader2 size={16} className="spin" aria-hidden /> Loading…
          </div>
        ) : data.folders.length === 0 ? (
          <p className="muted small pad">No folders in here.</p>
        ) : (
          data.folders.map((f) => (
            <button key={f.id} type="button" className="moveItem" onClick={() => setAt(f.id)} role="option" aria-selected={false}>
              <KindIcon kind="folder" />
              <span className="nameText">{f.name}</span>
              <ChevronRight size={16} aria-hidden />
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

function StoragePool({ pool, onDisconnect, onRefresh }: { pool: Pool; onDisconnect: (a: GoogleAccount) => void; onRefresh: () => void }) {
  return (
    <>
      <div className="poolSummary">
        <div>
          <div className="big">{pool.totals.unlimitedGoogle ? "∞" : formatBytes(pool.totals.googleFree)}</div>
          <div className="muted">free in Google Drive</div>
        </div>
        <div>
          <div className="big">∞</div>
          <div className="muted">Telegram (no fixed cap)</div>
        </div>
        {pool.r2.configured && (
          <div>
            <div className="big">{formatBytes(pool.r2.free)}</div>
            <div className="muted">free in Cloudflare R2</div>
          </div>
        )}
        <div>
          <div className="big">{formatBytes(pool.totals.storedByApp)}</div>
          <div className="muted">stored by this app</div>
        </div>
      </div>

      <div className="acct">
        <div className="acctTop">
          <strong>Telegram</strong>
          <span className="muted">{pool.telegram.configured ? "connected via bot" : "not configured"}</span>
        </div>
        <div className="muted small">
          {pool.telegram.files} files · {formatBytes(pool.telegram.bytes)}
        </div>
      </div>

      {pool.r2.configured && (
        <div className="acct">
          <div className="acctTop">
            <strong>Cloudflare R2</strong>
            <span className="muted">fast &amp; reliable</span>
          </div>
          <div className="meter">
            <div
              style={{ width: `${Math.min(100, (pool.r2.used / Math.max(1, pool.r2.limit)) * 100)}%` }}
              className={pool.r2.free < pool.r2.limit * 0.1 ? "full" : ""}
            />
          </div>
          <div className="muted small">
            {formatBytes(pool.r2.free)} free · you use {formatBytes(pool.r2.used)} ({pool.r2.files} files)
          </div>
        </div>
      )}

      {pool.google.map((g) => {
        const pct = g.limit ? Math.min(100, (g.used / g.limit) * 100) : 0;
        return (
          <div className="acct" key={g.id}>
            <div className="acctTop">
              <strong title={g.name ?? ""}>{g.email}</strong>
              <button type="button" className="linkBtn small danger" onClick={() => onDisconnect(g)}>
                Disconnect
              </button>
            </div>
            {g.needsReauth ? (
              <div className="small warnText">
                Access expired —{" "}
                <a href="/api/google/connect" className="inlineLink">
                  reconnect
                </a>
              </div>
            ) : (
              <>
                <div className="meter">
                  <div style={{ width: `${pct}%` }} className={pct > 90 ? "full" : ""} />
                </div>
                <div className="muted small">
                  {g.limit == null ? `${formatBytes(g.used)} used · unlimited` : `${formatBytes(g.free ?? 0)} free of ${formatBytes(g.limit)}`}
                  {" · "}
                  {g.app.files} files ({formatBytes(g.app.bytes)}) from this app
                </div>
              </>
            )}
          </div>
        );
      })}

      <div className="modalActions">
        {pool.googleConfigured ? (
          <a className="btn primary" href="/api/google/connect">
            <Plus size={16} aria-hidden /> Connect Google account
          </a>
        ) : (
          <span className="muted small">Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Google accounts.</span>
        )}
        <button type="button" className="btn" onClick={onRefresh}>
          <RotateCw size={16} aria-hidden /> Refresh
        </button>
      </div>
      <p className="muted small">
        Google storage is shared by Drive, Gmail and Photos. Each account&apos;s free space is shown as Google reports it.
        Files go into a “TG Drive” folder in that Drive.
      </p>
    </>
  );
}
