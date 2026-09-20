"use client";

import { useMemo, useRef } from "react";

/**
 * Velocity curve editor: speed (log scale, Y) over clip time (X).
 * Drag keyframes to move them; double-click empty space to add one;
 * double-click a point to remove it (minimum 2 remain).
 */

export interface SpeedKf {
  t: number;
  speed: number;
}

const W = 560;
const H = 180;
const PAD = { left: 40, right: 10, top: 10, bottom: 22 };
const S_MIN = 0.05;
const S_MAX = 4;
const GRID_SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

function smootherstep(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function rampSpeedAt(
  kfs: SpeedKf[],
  t: number,
  smoothness: number,
): number {
  const s = [...kfs].sort((a, b) => a.t - b.t);
  const first = s[0]!;
  const last = s[s.length - 1]!;
  if (t <= first.t) return first.speed;
  if (t >= last.t) return last.speed;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (t <= b.t) {
      const u = (t - a.t) / Math.max(0.001, b.t - a.t);
      const eased = (1 - smoothness) * u + smoothness * smootherstep(u);
      return a.speed + (b.speed - a.speed) * eased;
    }
  }
  return last.speed;
}

/** Numeric estimate of the output duration under the curve. */
export function rampOutputDuration(
  kfs: SpeedKf[],
  smoothness: number,
  clipDuration: number,
): number {
  if (kfs.length < 2) return clipDuration;
  const steps = 300;
  let out = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * clipDuration;
    out += clipDuration / steps / rampSpeedAt(kfs, t, smoothness);
  }
  return out;
}

export function VelocityCurveEditor({
  keyframes,
  smoothness,
  clipDuration,
  onChange,
}: {
  keyframes: SpeedKf[];
  smoothness: number;
  clipDuration: number;
  onChange: (kfs: SpeedKf[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xOf = (t: number) => PAD.left + (t / clipDuration) * plotW;
  const yOf = (s: number) =>
    PAD.top +
    plotH -
    ((Math.log(s) - Math.log(S_MIN)) / (Math.log(S_MAX) - Math.log(S_MIN))) *
      plotH;
  const tOf = (x: number) =>
    Math.max(0, Math.min(clipDuration, ((x - PAD.left) / plotW) * clipDuration));
  const sOf = (y: number) => {
    const frac = Math.max(0, Math.min(1, (PAD.top + plotH - y) / plotH));
    return Math.exp(Math.log(S_MIN) + frac * (Math.log(S_MAX) - Math.log(S_MIN)));
  };

  const sorted = useMemo(
    () => [...keyframes].sort((a, b) => a.t - b.t),
    [keyframes],
  );

  const curvePath = useMemo(() => {
    if (sorted.length < 2) return "";
    const pts: string[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * clipDuration;
      pts.push(
        `${i === 0 ? "M" : "L"}${xOf(t).toFixed(1)},${yOf(rampSpeedAt(sorted, t, smoothness)).toFixed(1)}`,
      );
    }
    return pts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, smoothness, clipDuration]);

  const svgPoint = (ev: React.PointerEvent | React.MouseEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (dragIndex.current === null) return;
    const { x, y } = svgPoint(ev);
    const next = [...sorted];
    const i = dragIndex.current;
    const lo = i > 0 ? next[i - 1]!.t + 0.05 : 0;
    const hi = i < next.length - 1 ? next[i + 1]!.t - 0.05 : clipDuration;
    next[i] = {
      t: Math.round(Math.max(lo, Math.min(hi, tOf(x))) * 100) / 100,
      speed: Math.round(sOf(y) * 100) / 100,
    };
    onChange(next);
  };

  const onDoubleClick = (ev: React.MouseEvent) => {
    const { x, y } = svgPoint(ev);
    // Near an existing point? remove it (keep at least 2)
    const hitIndex = sorted.findIndex(
      (k) => Math.abs(xOf(k.t) - x) < 10 && Math.abs(yOf(k.speed) - y) < 10,
    );
    if (hitIndex >= 0) {
      if (sorted.length > 2) {
        onChange(sorted.filter((_, i) => i !== hitIndex));
      }
      return;
    }
    onChange(
      [...sorted, { t: Math.round(tOf(x) * 100) / 100, speed: Math.round(sOf(y) * 100) / 100 }].sort(
        (a, b) => a.t - b.t,
      ),
    );
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full touch-none select-none rounded-md border border-border bg-black/40"
      onPointerMove={onPointerMove}
      onPointerUp={() => (dragIndex.current = null)}
      onPointerLeave={() => (dragIndex.current = null)}
      onDoubleClick={onDoubleClick}
    >
      {GRID_SPEEDS.map((s) => (
        <g key={s}>
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yOf(s)}
            y2={yOf(s)}
            stroke={s === 1 ? "#8b93a7" : "#262b38"}
            strokeWidth={s === 1 ? 1 : 0.75}
            strokeDasharray={s === 1 ? "" : "3 3"}
          />
          <text x={4} y={yOf(s) + 3} fontSize={9} fill="#8b93a7">
            {s}x
          </text>
        </g>
      ))}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <text
          key={f}
          x={xOf(f * clipDuration)}
          y={H - 6}
          fontSize={9}
          fill="#8b93a7"
          textAnchor="middle"
        >
          {(f * clipDuration).toFixed(0)}s
        </text>
      ))}
      <path d={curvePath} fill="none" stroke="#6d5cff" strokeWidth={2} />
      {sorted.map((k, i) => (
        <circle
          key={i}
          cx={xOf(k.t)}
          cy={yOf(k.speed)}
          r={7}
          fill="#38e1c6"
          stroke="#0b0d12"
          strokeWidth={2}
          className="cursor-grab"
          onPointerDown={(ev) => {
            dragIndex.current = i;
            (ev.target as Element).setPointerCapture(ev.pointerId);
          }}
        />
      ))}
    </svg>
  );
}
