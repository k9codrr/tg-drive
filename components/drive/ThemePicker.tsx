"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { applyPrefs, DESIGN_INFO, DESIGNS, resolveMode, type Design, type Mode, type Prefs } from "./theme";

const MODES: { value: Mode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Little drawing of each design, rendered with that design's own colours. */
function Mock({ design, mode }: { design: Design; mode: "light" | "dark" }) {
  const rows = [0, 1, 2, 3];
  return (
    <div className={`mock mock-${design}`} data-design={design} data-mode={mode} aria-hidden>
      {design === "conferio" && (
        <div className="mRail">
          {rows.map((i) => (
            <i key={i} />
          ))}
        </div>
      )}
      <div className="mSide">
        {design === "classic" ? <div className="mNew" /> : <div className="mAcct" />}
        {rows.map((i) => (
          <div key={i} className={`mNav ${i === 0 ? "on" : ""}`} />
        ))}
        <div className="mStore" />
      </div>
      <div className="mMain">
        <div className="mTop" />
        {design === "nimbus" ? (
          <div className="mTable">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="mRow">
                <i className={`d${i % 4}`} />
                <b />
              </div>
            ))}
          </div>
        ) : (
          <div className="mGrid">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="mCard">
                <i className={`d${i % 4}`} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ThemePicker({
  initial,
  onDone,
  onCancel,
  firstRun = false,
}: {
  initial: Prefs;
  onDone: (p: Prefs) => void;
  onCancel?: () => void;
  firstRun?: boolean;
}) {
  const [design, setDesign] = useState<Design>(initial.design);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [resolved, setResolved] = useState<"light" | "dark">("light");

  // Live preview: the whole page switches as you choose.
  useEffect(() => {
    applyPrefs({ design, mode });
    setResolved(resolveMode(mode));
  }, [design, mode]);

  const cancel = () => {
    applyPrefs(initial);
    onCancel?.();
  };

  useEffect(() => {
    if (!onCancel) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <div className={`picker ${firstRun ? "firstRun" : "overlay"}`} role="dialog" aria-modal="true" aria-labelledby="pickerTitle">
      <div className="pickerInner">
        <header className="pickerHead">
          {firstRun && <div className="pickerStep">Welcome to TG Drive</div>}
          <h1 id="pickerTitle">Choose how your drive looks</h1>
          <p className="muted">Pick a design you like. You can change it any time in Settings.</p>
        </header>

        <div className="designGrid" role="radiogroup" aria-label="Design">
          {DESIGNS.map((d) => {
            const info = DESIGN_INFO[d];
            const on = d === design;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={on}
                className={`designCard ${on ? "on" : ""}`}
                onClick={() => setDesign(d)}
              >
                <Mock design={d} mode={resolved} />
                <div className="designText">
                  <div className="designName">
                    {info.name}
                    {on && (
                      <span className="designCheck">
                        <Check size={14} aria-hidden /> Selected
                      </span>
                    )}
                  </div>
                  <div className="muted small">{info.tagline}</div>
                  <ul>
                    {info.points.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </div>
              </button>
            );
          })}
        </div>

        <div className="pickerFoot">
          <div className="segmented" role="radiogroup" aria-label="Colour mode">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                className={mode === m.value ? "on" : ""}
                onClick={() => setMode(m.value)}
              >
                <m.icon size={16} aria-hidden />
                {m.label}
              </button>
            ))}
          </div>
          <div className="pickerActions">
            {onCancel && (
              <button type="button" className="btn ghost" onClick={cancel}>
                Cancel
              </button>
            )}
            <button type="button" className="btn primary lg" onClick={() => onDone({ design, mode })} autoFocus>
              {firstRun ? "Continue to my drive" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
