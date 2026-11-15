"use client";

import { AlertTriangle, CheckCircle2, Info, Loader2, X, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

// ---------- Modal ----------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  className = "",
  labelledBy,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("[autofocus], input, textarea, select") ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab" && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (!items.length) return;
        const [a, z] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.classList.add("noScroll");
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.classList.remove("noScroll");
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="modalBack" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${wide ? "wide" : ""} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
        tabIndex={-1}
      >
        {title !== undefined && (
          <div className="modalHead">
            <h2 id={titleId}>{title}</h2>
            <IconButton icon={X} label="Close" onClick={onClose} />
          </div>
        )}
        <div className="modalBody">{children}</div>
        {footer && <div className="modalFoot">{footer}</div>}
      </div>
    </div>
  );
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  className = "",
  size = 18,
  active,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  size?: number;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`iconBtn ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={size} aria-hidden />
    </button>
  );
}

// ---------- Prompt / Confirm ----------

export function PromptDialog({
  title,
  label,
  initial = "",
  confirmText = "Save",
  onSubmit,
  onClose,
  selectBase = false,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmText?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
  selectBase?: boolean; // select the name without its extension (like rename in Explorer)
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (selectBase && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectBase]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return setError("Please enter a name.");
    if (/[\\/]/.test(v)) return setError("Names can't contain / or \\.");
    if (v === initial) return onClose();
    setBusy(true);
    setError("");
    try {
      await onSubmit(v);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="formStack">
        <label htmlFor={id} className="fieldLabel">
          {label}
        </label>
        <input
          id={id}
          ref={input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={255}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        {error && (
          <p id={`${id}-err`} className="fieldError" role="alert">
            {error}
          </p>
        )}
        <div className="modalActions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" aria-hidden />}
            {confirmText}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmText = "Delete",
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirmBody">{body}</div>
      {error && (
        <p className="fieldError" role="alert">
          {error}
        </p>
      )}
      <div className="modalActions end">
        <button type="button" className="btn ghost" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className={`btn ${danger ? "danger solid" : "primary"}`} onClick={go} disabled={busy}>
          {busy && <Loader2 size={16} className="spin" aria-hidden />}
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Menu (dropdown + right-click) ----------

export type MenuItem =
  | { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; shortcut?: string }
  | "separator";

export type MenuAnchor = { x: number; y: number; alignRight?: boolean };

export function Menu({ anchor, items, onClose }: { anchor: MenuAnchor; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.alignRight ? anchor.x - r.width : anchor.x;
    let top = anchor.y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.y - r.height);
    setPos({ left: Math.max(8, left), top });
    el.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const scroll = () => onClose();
    document.addEventListener("mousedown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", scroll);
    window.addEventListener("blur", scroll);
    return () => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", scroll);
      window.removeEventListener("blur", scroll);
    };
  }, [onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div ref={ref} className="menu" role="menu" style={pos} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="menuSep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menuItem ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon ? <it.icon size={16} aria-hidden /> : <span className="menuIconPad" />}
            <span>{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

// ---------- Toasts ----------

export type Toast = {
  id: number;
  kind: "info" | "success" | "error" | "progress";
  text: string;
  action?: { label: string; run: () => void };
  progress?: number;
};

const TOAST_ICON = { info: Info, success: CheckCircle2, error: AlertTriangle, progress: Loader2 };

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions text">
      {toasts.map((t) => {
        const Icon = TOAST_ICON[t.kind];
        return (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <Icon size={18} aria-hidden className={t.kind === "progress" ? "spin" : ""} />
            <span className="toastText">{t.text}</span>
            {t.action && (
              <button
                type="button"
                className="toastAction"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.kind !== "progress" && <IconButton icon={X} label="Dismiss" size={15} onClick={() => dismiss(t.id)} />}
            {t.kind === "progress" && t.progress != null && (
              <div className="toastBar" aria-hidden>
                <div style={{ width: `${t.progress}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
