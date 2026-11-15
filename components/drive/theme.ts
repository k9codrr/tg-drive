// Look & feel: three designs, each in light or dark. Saved per browser; applied before first paint
// by the inline script in app/layout.tsx (THEME_BOOT) so pages never flash the wrong theme.

export type Design = "nimbus" | "classic" | "conferio";
export type Mode = "light" | "dark" | "system";
export type Prefs = { design: Design; mode: Mode };

export const PREFS_KEY = "tgd_ui";
export const DESIGNS: Design[] = ["nimbus", "classic", "conferio"];

export const DESIGN_INFO: Record<Design, { name: string; tagline: string; points: string[] }> = {
  nimbus: {
    name: "Nimbus",
    tagline: "Calm and minimal, made for focus",
    points: ["Clean stone palette", "Compact file table", "Storage meter in the sidebar"],
  },
  classic: {
    name: "Classic",
    tagline: "The layout you know from the big cloud drives",
    points: ["Big New button and search bar", "Folder cards and thumbnails", "Bright blue accents"],
  },
  conferio: {
    name: "Conferio",
    tagline: "Your Conferio workspace style",
    points: ["Icon rail and drive views", "Rounded content panel", "Media-first grid"],
  },
};

export function loadPrefs(): Prefs | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Prefs>;
    if (!p.design || !DESIGNS.includes(p.design)) return null;
    const mode: Mode = p.mode === "light" || p.mode === "dark" ? p.mode : "system";
    return { design: p.design, mode };
  } catch {
    return null;
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the choice still applies for this visit */
  }
}

export const resolveMode = (m: Mode): "light" | "dark" =>
  m === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : m;

export function applyPrefs(p: Prefs) {
  const root = document.documentElement;
  root.dataset.design = p.design;
  root.dataset.mode = resolveMode(p.mode);
  root.style.colorScheme = root.dataset.mode;
}

/** Runs in <head> before anything renders. Keep it tiny and dependency-free. */
export const THEME_BOOT = `(function(){try{var d=document.documentElement,p=JSON.parse(localStorage.getItem("${PREFS_KEY}")||"null")||{},m=p.mode==="light"||p.mode==="dark"?p.mode:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");d.dataset.design=["nimbus","classic","conferio"].indexOf(p.design)>=0?p.design:"nimbus";d.dataset.mode=m;d.style.colorScheme=m;}catch(e){}})();`;
