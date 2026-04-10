import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { supabase } from './supabase.js'

// ══════════════════════════════════════════════════════════════════════════
// CONSTANTS & PURE HELPERS
// ══════════════════════════════════════════════════════════════════════════

export const CYLINDER_PRESETS = [
  { id: '3kg',  label: '3 kg',  net_g:  3000, tare_g:  5000 },
  { id: '6kg',  label: '6 kg',  net_g:  6000, tare_g:  8000 },
  { id: '12kg', label: '12 kg', net_g: 12000, tare_g: 14000 },
  { id: '15kg', label: '15 kg', net_g: 15000, tare_g: 17000 },
]
const DEFAULT_CYLINDER = '6kg'

// ── MQ6 safety thresholds ─────────────────────────────────────────────────
// These MUST match PPM_SAFE_LIMIT and PPM_LOW_LIMIT in the ESP32 firmware.
// ESP32 firmware: severity = "safe" below 200, "low" below 1000, "high" at/above 1000
const LPG_PPM_LOW  = 200   // matches PPM_SAFE_LIMIT in firmware
const LPG_PPM_HIGH = 1000  // matches PPM_LOW_LIMIT  in firmware

// ── Supabase table names — must match #define in firmware ─────────────────
// gasTable    = "gas_leakages"   → columns: id, severity, raw_value, ppm_approx, created_at
// weightTable = "gas_levels"     → columns: id, weight_grams, created_at

const weightToPercent = (weight_g, preset, customTare_g = null) => {
  if (weight_g == null || !preset) return 0
  const w    = parseFloat(weight_g)
  const tare = customTare_g != null ? parseFloat(customTare_g) : preset.tare_g
  if (isNaN(w) || isNaN(tare)) return 0
  const raw = ((w - tare) / preset.net_g) * 100
  return isNaN(raw) ? 0 : parseFloat(Math.min(100, Math.max(0, raw)).toFixed(2))
}

const gasRemainingKg = (weight_g, preset, customTare_g = null) => {
  if (weight_g == null || !preset) return 0
  const w    = parseFloat(weight_g)
  const tare = customTare_g != null ? parseFloat(customTare_g) : preset.tare_g
  if (isNaN(w)) return 0
  return Math.min(Math.max(0, w - tare) / 1000, preset.net_g / 1000)
}

// Always derive severity from ppm — never trust the ESP32 severity field alone.
// This mirrors the firmware logic exactly:
//   ppm < LPG_PPM_LOW  → "safe"
//   ppm < LPG_PPM_HIGH → "low"
//   ppm >= LPG_PPM_HIGH → "high"
const deriveSeverity = (ppm) => {
  if (ppm == null || ppm < LPG_PPM_LOW) return 'safe'
  if (ppm >= LPG_PPM_HIGH) return 'high'
  return 'low'
}

// Only surface ppm values that are at or above the warning floor
const filterPpm = (ppm) => (ppm != null && ppm >= LPG_PPM_LOW ? Number(ppm) : null)

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })
const isConfigured = () => !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

// Estimate days remaining — use rolling slope of levelHistory if enough data
const estimateDays = (gasLevel, levelHistory) => {
  if (gasLevel <= 0) return 0
  if (levelHistory.length >= 10) {
    const recent = levelHistory.slice(-10)
    const drops  = recent.slice(1).map((v, i) => recent[i] - v).filter(d => d > 0)
    if (drops.length >= 3) {
      const avgDropPerReading = drops.reduce((a, b) => a + b, 0) / drops.length
      const readingsPerDay    = 17280  // one reading every 5 s
      const daysLeft          = gasLevel / (avgDropPerReading * readingsPerDay)
      if (daysLeft > 0 && daysLeft < 365) return Math.ceil(daysLeft)
    }
  }
  return Math.max(0, Math.ceil(gasLevel / 2.1))
}

// ── Safety recommendations ────────────────────────────────────────────────
const getRecommendations = (severity, gasLevel, ppm) => {
  if (severity === 'high') return [
    { icon: '🚨', text: 'EVACUATE immediately — do not delay', urgent: true },
    { icon: '⚡', text: 'Cut all electrical power at the mains', urgent: true },
    { icon: '🚫', text: 'Do NOT flip switches or use any appliances', urgent: true },
    { icon: '🪟', text: 'Open all windows and doors if safe to do so', urgent: true },
    { icon: '📞', text: 'Call emergency services from outside the building', urgent: false },
    ppm >= 1500
      ? { icon: '☣️', text: `~${Math.round(ppm)} ppm — extremely dangerous, stay clear`, urgent: true }
      : { icon: '📊', text: `MQ6: ~${ppm ? Math.round(ppm) : '—'} ppm (≥1000 ppm = ignition risk zone)`, urgent: false },
  ]
  if (severity === 'low') return [
    { icon: '⚠️', text: 'Gas detected — open windows and ventilate now', urgent: true },
    { icon: '🔥', text: 'Turn off all flames and ignition sources immediately', urgent: true },
    { icon: '🔍', text: 'Inspect cylinder valve and hose connections for leaks', urgent: true },
    { icon: '🚭', text: 'No smoking — do not operate any electrical switches', urgent: false },
    { icon: '👁️', text: 'Monitor readings — escalate immediately if above 1000 ppm', urgent: false },
    ppm
      ? { icon: '📊', text: `Current MQ6: ~${Math.round(ppm)} ppm — early leak accumulation`, urgent: false }
      : { icon: '📊', text: 'Watch PPM trend — call supplier if it keeps rising', urgent: false },
  ]
  if (gasLevel < 20) return [
    { icon: '📦', text: 'Cylinder critically low — arrange refill today', urgent: true },
    { icon: '📋', text: 'Contact your LPG supplier now', urgent: false },
    { icon: '🕐', text: 'Estimated less than a week of gas remaining', urgent: false },
  ]
  if (gasLevel < 40) return [
    { icon: '📦', text: 'Below 40% — schedule a refill this week', urgent: false },
    { icon: '📊', text: 'Track daily usage in the Analytics tab', urgent: false },
  ]
  return [
    { icon: '✅', text: 'System operating normally — all clear', urgent: false },
    { icon: '🔍', text: 'Perform routine monthly valve and hose inspection', urgent: false },
  ]
}

// ── Color tokens ──────────────────────────────────────────────────────────
const C = {
  safe: { main: '#00e5a0', dim: 'rgba(0,229,160,0.10)',  border: 'rgba(0,229,160,0.22)',  glow: '0 0 28px rgba(0,229,160,0.28)' },
  low:  { main: '#ffb020', dim: 'rgba(255,176,32,0.10)', border: 'rgba(255,176,32,0.22)', glow: '0 0 28px rgba(255,176,32,0.28)' },
  high: { main: '#ff4560', dim: 'rgba(255,69,96,0.10)',  border: 'rgba(255,69,96,0.22)',  glow: '0 0 28px rgba(255,69,96,0.38)' },
}
const levelColor = l => l < 20 ? C.high : l < 40 ? C.low : C.safe

// ── Demo data ─────────────────────────────────────────────────────────────
let demoTick = 0
const DEMO_CYCLE_SEVS = ['safe','safe','safe','safe','low','low','safe','safe','high','safe','safe','safe']
const DEMO_CYCLE_PPM  = [  48,   55,   51,   62,  280,  320,   58,   50,  1200,   53,   47,   55 ]
const genDemoWeight = prev => Math.max(8050, Math.min(14000, (prev ?? 11400) + (Math.random() - 0.52) * 28))

// ══════════════════════════════════════════════════════════════════════════
// UI PRIMITIVES
// ══════════════════════════════════════════════════════════════════════════

function StatusDot({ online }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: online ? '#00e5a0' : '#ff4560',
      boxShadow: online ? '0 0 8px #00e5a0' : '0 0 8px #ff4560',
      animation: online ? 'pulseGreen 2s ease infinite' : 'pulseRed 1.5s ease infinite',
    }} />
  )
}

function Chip({ label, color, bg, border, style }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px',
      borderRadius: 20, background: bg || 'rgba(255,255,255,0.06)',
      border: `1px solid ${border || 'rgba(255,255,255,0.1)'}`,
      fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500,
      color: color || 'var(--text-2)', letterSpacing: '0.05em', whiteSpace: 'nowrap',
      ...style
    }}>{label}</span>
  )
}

function Card({ children, style, accent, glow }) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: `1px solid ${accent ? accent + '28' : 'var(--border)'}`,
      borderRadius: 'var(--r)', padding: '18px 16px',
      boxShadow: glow || 'var(--shadow)',
      transition: 'box-shadow 0.3s, border-color 0.3s',
      minWidth: 0,
      ...style
    }}>{children}</div>
  )
}

function SectionTitle({ children, style }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
      color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase',
      marginBottom: 14, ...style
    }}>{children}</div>
  )
}

// ── Arc Gauge ─────────────────────────────────────────────────────────────
function ArcGauge({ value, color, size = 160 }) {
  const r = size * 0.38, cx = size / 2, cy = size / 2
  const startAngle = -210, totalArc = 240
  const safeValue = isNaN(value) || value == null ? 0 : Math.min(100, Math.max(0, value))
  const valueArc  = (safeValue / 100) * totalArc
  const toRad = a => (a * Math.PI) / 180
  const arcPath = (startA, endA) => {
    const [x1, y1] = [cx + r * Math.cos(toRad(startA)), cy + r * Math.sin(toRad(startA))]
    const [x2, y2] = [cx + r * Math.cos(toRad(endA)),   cy + r * Math.sin(toRad(endA))]
    return `M ${x1} ${y1} A ${r} ${r} 0 ${Math.abs(endA - startA) > 180 ? 1 : 0} 1 ${x2} ${y2}`
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      <path d={arcPath(startAngle, startAngle + totalArc)} fill="none"
        stroke="rgba(255,255,255,0.05)" strokeWidth={size * 0.07} strokeLinecap="round" />
      <path d={arcPath(startAngle, startAngle + valueArc)} fill="none" stroke={color}
        strokeWidth={size * 0.07} strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'all 1s cubic-bezier(0.34,1.56,0.64,1)' }} />
      <text x={cx} y={cy - 4} textAnchor="middle" fill={color}
        style={{ fontFamily: "'Outfit',sans-serif", fontSize: size * 0.22, fontWeight: 800, transition: 'fill 0.4s' }}>
        {Math.round(safeValue)}%
      </text>
      <text x={cx} y={cy + size * 0.13} textAnchor="middle" fill="var(--text-3)"
        style={{ fontFamily: "'DM Mono',monospace", fontSize: size * 0.074, letterSpacing: '0.1em' }}>
        GAS LEVEL
      </text>
    </svg>
  )
}

// ── PPM Bar (segmented zones: safe / low / high) ──────────────────────────
function PpmBar({ ppm }) {
  const MAX      = 2000
  const fPpm     = filterPpm(ppm)
  const pct      = Math.min(100, ((fPpm || 0) / MAX) * 100)
  const severity = deriveSeverity(fPpm)
  const col      = severity === 'high' ? C.high.main : severity === 'low' ? C.low.main : C.safe.main
  const lowPct   = (LPG_PPM_LOW  / MAX) * 100   // 10%
  const highPct  = (LPG_PPM_HIGH / MAX) * 100   // 50%
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6,
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
        <span>MQ6 LPG concentration</span>
        <span style={{ color: fPpm ? col : 'var(--text-3)', fontWeight: 600, transition: 'color 0.4s' }}>
          {fPpm != null ? `~${Math.round(fPpm)} ppm` : '< 200 ppm (safe)'}
        </span>
      </div>
      <div style={{ position: 'relative', background: 'var(--surface3)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background:
          `linear-gradient(90deg, rgba(0,229,160,0.18) 0%, rgba(0,229,160,0.18) ${lowPct}%,
           rgba(255,176,32,0.18) ${lowPct}%, rgba(255,176,32,0.18) ${highPct}%,
           rgba(255,69,96,0.18) ${highPct}%, rgba(255,69,96,0.18) 100%)` }} />
        <div style={{ position: 'relative', width: `${pct}%`, height: '100%', borderRadius: 6,
          background: `linear-gradient(90deg, #00e5a0, ${col})`,
          transition: 'width 1s ease, background 0.4s ease',
          boxShadow: fPpm ? `0 0 8px ${col}60` : 'none' }} />
        {[lowPct, highPct].map((pos, i) => (
          <div key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${pos}%`,
            width: 1, background: 'rgba(255,255,255,0.25)' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5,
          fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>
        <span style={{ color: C.safe.main }}>0</span>
        <span style={{ color: C.low.main }}>200 (warn)</span>
        <span style={{ color: C.high.main }}>1000 (danger)</span>
        <span>2000 ppm</span>
      </div>
    </div>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 40 }) {
  if (!data || data.length < 2) return null
  const w = 300, h = height, pad = 4
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1
  const pts = data.map((v, i) => [
    pad + (i / (data.length - 1)) * (w - pad * 2),
    h - pad - ((v - min) / range) * (h - pad * 2)
  ])
  const line = pts.map(p => p.join(',')).join(' ')
  const area = `M${pad},${h} L${pts.map(p => p.join(',')).join(' L')} L${w - pad},${h} Z`
  const gradId = `sg-${color.replace('#', '')}`
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3"
        fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  )
}

// ── Bar Chart ─────────────────────────────────────────────────────────────
function BarChart({ data, color, showValues = true }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  const max      = Math.max(...data.map(d => d.value), 1)
  const barAreaH = 100
  const yAxisW   = 38
  const yTicks   = [0, Math.round(max * 0.5), max]
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ width: yAxisW, display: 'flex', flexDirection: 'column',
            justifyContent: 'space-between', height: barAreaH, paddingRight: 6,
            borderRight: '1px solid var(--border)' }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
                color: 'var(--text-3)', textAlign: 'right', lineHeight: 1 }}>{tick}</div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: barAreaH,
              borderBottom: '1px solid var(--border)' }}>
            {data.map((d, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', height: '100%', justifyContent: 'flex-end', minWidth: 0 }}>
                <div style={{ position: 'relative', width: '100%', borderRadius: '3px 3px 0 0',
                    height: `${Math.max(d.value > 0 ? 4 : 0, (d.value / max) * (barAreaH - 22))}px`,
                    background: color, opacity: d.value > 0 ? 1 : 0.12,
                    transition: 'height 0.6s cubic-bezier(.4,0,.2,1)' }}>
                  {showValues && d.value > 0 && (
                    <div style={{ position: 'absolute', top: -18, left: '50%',
                        transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)',
                        fontSize: 9, color: color, fontWeight: 700, whiteSpace: 'nowrap',
                        background: 'rgba(0,0,0,0.75)', padding: '1px 4px', borderRadius: 3,
                        pointerEvents: 'none' }}>{d.value}</div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
                    color: 'var(--text-3)', marginTop: 4 }}>{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Dual Bar Chart (high/low leaks) ───────────────────────────────────────
function DualBarChart({ data, showValues = true }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  const max      = Math.max(...data.map(d => Math.max(d.high, d.low)), 1)
  const barAreaH = 100
  const yAxisW   = 38
  const yTicks   = [0, Math.round(max * 0.5), max]
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ width: yAxisW, display: 'flex', flexDirection: 'column',
            justifyContent: 'space-between', height: barAreaH, paddingRight: 6,
            borderRight: '1px solid var(--border)' }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
                color: 'var(--text-3)', textAlign: 'right', lineHeight: 1 }}>{tick}</div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: barAreaH,
              borderBottom: '1px solid var(--border)' }}>
            {data.map((d, i) => {
              const totalH   = Math.max(d.high, d.low)
              const groupH   = Math.max(totalH > 0 ? 4 : 0, (totalH / max) * (barAreaH - 22))
              const highBarH = totalH > 0 ? (d.high / totalH) * 100 : 0
              const lowBarH  = totalH > 0 ? (d.low  / totalH) * 100 : 0
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column',
                    alignItems: 'center', height: '100%', justifyContent: 'flex-end', minWidth: 0 }}>
                  <div style={{ width: '100%', display: 'flex', gap: 2,
                      alignItems: 'flex-end', height: groupH }}>
                    <div style={{ flex: 1, borderRadius: '2px 2px 0 0', position: 'relative',
                        height: `${highBarH}%`, minHeight: d.high > 0 ? 3 : 0,
                        background: '#ff4560', opacity: d.high > 0 ? 1 : 0.1,
                        transition: 'height 0.6s cubic-bezier(.4,0,.2,1)' }}>
                      {showValues && d.high > 0 && (
                        <div style={{ position: 'absolute', top: -17, left: '50%',
                            transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)',
                            fontSize: 8, color: '#ff4560', fontWeight: 700, whiteSpace: 'nowrap',
                            background: 'rgba(0,0,0,0.75)', padding: '1px 3px', borderRadius: 3,
                            pointerEvents: 'none' }}>{d.high}</div>
                      )}
                    </div>
                    <div style={{ flex: 1, borderRadius: '2px 2px 0 0', position: 'relative',
                        height: `${lowBarH}%`, minHeight: d.low > 0 ? 3 : 0,
                        background: '#ffb020', opacity: d.low > 0 ? 1 : 0.1,
                        transition: 'height 0.6s cubic-bezier(.4,0,.2,1)' }}>
                      {showValues && d.low > 0 && (
                        <div style={{ position: 'absolute', top: -17, left: '50%',
                            transform: 'translateX(-50%)', fontFamily: 'var(--font-mono)',
                            fontSize: 8, color: '#ffb020', fontWeight: 700, whiteSpace: 'nowrap',
                            background: 'rgba(0,0,0,0.75)', padding: '1px 3px', borderRadius: 3,
                            pointerEvents: 'none' }}>{d.low}</div>
                      )}
                    </div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
                      color: 'var(--text-3)', marginTop: 4 }}>{d.label}</span>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 10, justifyContent: 'center' }}>
            {[['#ff4560','Critical (≥1000 ppm)'], ['#ffb020','Warning (200–999 ppm)']].map(([col, lbl]) => (
              <span key={lbl} style={{ fontFamily: 'var(--font-mono)', fontSize: 10,
                  display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-3)' }}>
                <span style={{ width: 10, height: 10, background: col, borderRadius: 2, flexShrink: 0 }} />
                {lbl}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Cylinder Selector ──────────────────────────────────────────────────────
function CylinderSelector({ selectedId, onChange }) {
  return (
    <div>
      <SectionTitle>⚖️ Gas Cylinder Size</SectionTitle>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-2)',
          marginBottom: 14, lineHeight: 1.6 }}>
        Select your LPG cylinder size. This determines how gas level (%) is calculated from the load cell reading.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {CYLINDER_PRESETS.map(p => {
          const active = p.id === selectedId
          return (
            <button key={p.id} onClick={() => onChange(p.id)} style={{
              padding: '14px 8px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
              border: active ? '1.5px solid #4d8eff' : '1px solid var(--border)',
              background: active ? 'rgba(77,142,255,0.12)' : 'var(--surface2)',
              color: active ? '#4d8eff' : 'var(--text-2)',
              fontFamily: 'var(--font-disp)', fontSize: 18, fontWeight: 800,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              transition: 'all 0.2s',
            }}>
              {p.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 400,
                  color: active ? 'rgba(77,142,255,0.8)' : 'var(--text-3)' }}>
                {(p.net_g / 1000).toFixed(0)}kg gas
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 400,
                  color: 'var(--text-3)' }}>
                tare {(p.tare_g / 1000).toFixed(0)}kg
              </span>
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 'var(--r-sm)',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', lineHeight: 1.8 }}>
        Formula: <span style={{ color: 'var(--text-2)' }}>(sensor_g − tare_g) ÷ net_gas_g × 100</span> · Clamped 0–100%
      </div>
    </div>
  )
}

// ── Cooking Mode Toggle ────────────────────────────────────────────────────
function CookingModeToggle({ active, onToggle, cookingStart }) {
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    if (!active || !cookingStart) { setElapsed(''); return }
    const iv = setInterval(() => {
      const mins = Math.floor((Date.now() - cookingStart) / 60000)
      setElapsed(`${mins}m`)
    }, 30000)
    return () => clearInterval(iv)
  }, [active, cookingStart])
  return (
    <button onClick={onToggle}
      title={active ? 'Cooking Mode ON — tap to disable' : 'Pause MQ6 alerts while cooking'}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20,
        border: active ? '1px solid rgba(255,176,32,0.5)' : '1px solid var(--border)',
        background: active ? 'rgba(255,176,32,0.12)' : 'var(--surface2)',
        color: active ? '#ffb020' : 'var(--text-3)',
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, cursor: 'pointer',
        transition: 'all 0.25s', letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}>
      <span style={{ fontSize: 13 }}>🍳</span>
      {active ? `COOKING${elapsed ? ` · ${elapsed}` : ''}` : 'COOKING'}
    </button>
  )
}

// ── Leak Alert Popup ────────────────────────────────────────────────────────
function LeakAlertPopup({ severity, ppm, gasLevel, onDismiss }) {
  const isHigh = severity === 'high'
  const col    = isHigh ? C.high : C.low
  const rules  = getRecommendations(severity, 100, ppm)

  const modalRef = useRef(null)
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onDismiss() }
    document.addEventListener('keydown', onKey)
    modalRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div
      role="alertdialog" aria-modal="true"
      aria-label={isHigh ? 'Critical gas leak alert' : 'Gas leak warning'}
      onClick={e => { if (e.target === e.currentTarget) onDismiss() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 600,
        background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '20px 16px',
        animation: 'fadeIn 0.18s ease',
      }}>
      <div ref={modalRef} tabIndex={-1} style={{
        width: '100%', maxWidth: 440,
        background: 'var(--surface)',
        border: `2px solid ${col.border}`,
        borderRadius: 'var(--r)',
        boxShadow: isHigh
          ? '0 0 60px rgba(255,69,96,0.45), 0 24px 48px rgba(0,0,0,0.6)'
          : '0 0 40px rgba(255,176,32,0.3), 0 24px 48px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        animation: 'slideUp 0.28s cubic-bezier(0.34,1.56,0.64,1)',
        outline: 'none',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{
          padding: '18px 20px',
          background: isHigh
            ? 'linear-gradient(135deg, rgba(255,69,96,0.18), rgba(255,69,96,0.08))'
            : 'linear-gradient(135deg, rgba(255,176,32,0.15), rgba(255,176,32,0.06))',
          borderBottom: `1px solid ${col.border}`,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{
            fontSize: 36, flexShrink: 0, lineHeight: 1,
            animation: isHigh ? 'pulseRed 1s ease infinite' : 'pulseAmber 1.5s ease infinite',
          }}>
            {isHigh ? '🚨' : '⚠️'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 18, fontWeight: 800,
                color: col.main, lineHeight: 1.15 }}>
              {isHigh ? 'CRITICAL GAS LEAK' : 'GAS LEAK DETECTED'}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: col.main,
                opacity: 0.8, marginTop: 4, letterSpacing: '0.04em' }}>
              MQ6 · ~{ppm ? Math.round(ppm) : '—'} ppm
              {isHigh ? ' · ≥1000 ppm DANGER ZONE' : ' · 200–999 ppm early warning'}
            </div>
          </div>
          <div style={{ textAlign: 'center', flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 22, fontWeight: 800,
                color: col.main, lineHeight: 1 }}>
              {ppm ? Math.round(ppm) : '—'}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9,
                color: 'var(--text-3)', letterSpacing: '0.06em' }}>PPM</div>
          </div>
        </div>

        <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rules.map((r, i) => (
            <div key={i} style={{
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: r.urgent ? col.dim : 'var(--surface2)',
              border: `1px solid ${r.urgent ? col.border : 'var(--border)'}`,
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{r.icon}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: 1.5,
                  color: r.urgent ? col.main : 'var(--text-2)', fontWeight: r.urgent ? 600 : 400 }}>
                {r.text}
              </span>
            </div>
          ))}
        </div>

        <div style={{ padding: '6px 16px 18px' }}>
          <button onClick={onDismiss} style={{
            width: '100%', padding: '12px', borderRadius: 10, cursor: 'pointer',
            background: isHigh ? '#ff4560' : 'rgba(255,176,32,0.2)',
            border: `1.5px solid ${col.border}`,
            color: isHigh ? '#fff' : col.main,
            fontFamily: 'var(--font-disp)', fontSize: 14, fontWeight: 700,
            letterSpacing: '0.05em',
            boxShadow: isHigh ? '0 0 20px rgba(255,69,96,0.5)' : '0 0 12px rgba(255,176,32,0.3)',
            transition: 'transform 0.1s',
          }}>
            {isHigh ? '🚨 I UNDERSTAND — TAKING ACTION NOW' : '✓ Acknowledged — I am ventilating'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  // ── Core sensor state ─────────────────────────────────────────────────
  const [rawWeightG,     setRawWeightG]     = useState(null)
  const [levelHistory,   setLevelHistory]   = useState([])
  const [severity,       setSeverity]       = useState('safe')
  const [currentPpm,     setCurrentPpm]     = useState(null)
  const [currentRaw,     setCurrentRaw]     = useState(null)
  const [ppmHistory,     setPpmHistory]     = useState([])

  // ── Connection / app state ────────────────────────────────────────────
  const [connected,      setConnected]      = useState(false)
  const [lastSeen,       setLastSeen]       = useState(new Date())
  const [loaded,         setLoaded]         = useState(false)
  const [tab,            setTab]            = useState('dashboard')

  // ── Demo mode ─────────────────────────────────────────────────────────
  const [demoMode] = useState(!isConfigured())

  // ── Cylinder config ───────────────────────────────────────────────────
  const [cylinderId, setCylinderIdRaw] = useState(
    () => localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER
  )
  const cylinderPreset    = CYLINDER_PRESETS.find(p => p.id === cylinderId) || CYLINDER_PRESETS[1]
  const cylinderPresetRef = useRef(cylinderPreset)
  useEffect(() => { cylinderPresetRef.current = cylinderPreset }, [cylinderPreset])

  const [customTare_g, setCustomTare_g] = useState(() => {
    const v = localStorage.getItem('gaswatch_custom_tare')
    return v != null ? parseFloat(v) : null
  })
  const customTareRef = useRef(customTare_g)
  useEffect(() => { customTareRef.current = customTare_g }, [customTare_g])

  const setCustomTare = useCallback((val) => {
    setCustomTare_g(val)
    if (val == null) localStorage.removeItem('gaswatch_custom_tare')
    else localStorage.setItem('gaswatch_custom_tare', String(val))
  }, [])

  const setCylinderId = useCallback((id) => {
    setCylinderIdRaw(id)
    localStorage.setItem('gaswatch_cylinder', id)
  }, [])

  // ── Derived gas level ─────────────────────────────────────────────────
  const gasLevel = useMemo(
    () => rawWeightG != null ? weightToPercent(rawWeightG, cylinderPreset, customTare_g) : 0,
    [rawWeightG, cylinderPreset, customTare_g]
  )

  useEffect(() => {
    if (rawWeightG == null) return
    const pct = weightToPercent(rawWeightG, cylinderPreset, customTare_g)
    setLevelHistory(prev => [...prev.slice(-59), pct])
  }, [rawWeightG, cylinderPreset, customTare_g])

  // ── Alarms & alerts ───────────────────────────────────────────────────
  const [alarmBanner,  setAlarmBanner]  = useState(false)
  const [alerts,       setAlerts]       = useState([])
  const [totalLeaks,   setTotalLeaks]   = useState(0)
  const [leakPopup,    setLeakPopup]    = useState(null)
  const lastPopupSev   = useRef('safe')

  // ── Cooking mode ──────────────────────────────────────────────────────
  const [cookingMode,  setCookingModeRaw]  = useState(() => localStorage.getItem('gaswatch_cooking') === 'true')
  const [cookingStart, setCookingStart]    = useState(null)
  const cookingRef = useRef(cookingMode)

  const setCookingMode = useCallback((val) => {
    setCookingModeRaw(val)
    cookingRef.current = val
    localStorage.setItem('gaswatch_cooking', val ? 'true' : 'false')
    if (val) {
      setCookingStart(Date.now())
    } else {
      setCookingStart(null)
      setAlarmBanner(false)
      clearInterval(alarmTimer.current)
      lastPopupSev.current = 'safe'
      setLeakPopup(null)
    }
  }, [])

  useEffect(() => {
    if (!cookingMode || !cookingStart) return
    const remaining = 2 * 60 * 60 * 1000 - (Date.now() - cookingStart)
    if (remaining <= 0) { setCookingMode(false); return }
    const t = setTimeout(() => setCookingMode(false), remaining)
    return () => clearTimeout(t)
  }, [cookingMode, cookingStart, setCookingMode])

  // ── Analytics ─────────────────────────────────────────────────────────
  const [weeklyUsage,      setWeeklyUsage]      = useState([])
  const [weeklyLeaksBySev, setWeeklyLeaksBySev] = useState([])
  const [weeklyPpm,        setWeeklyPpm]        = useState([])
  const [avgPpm7d,         setAvgPpm7d]         = useState(null)
  const [maxPpm7d,         setMaxPpm7d]         = useState(null)
  const [highLeaks7d,      setHighLeaks7d]      = useState(0)
  const [lowLeaks7d,       setLowLeaks7d]       = useState(0)

  // ── Audio alarm ───────────────────────────────────────────────────────
  const audioCtx   = useRef(null)
  const alarmTimer = useRef(null)

  const playAlarm = useCallback(() => {
    try {
      if (!audioCtx.current) audioCtx.current = new AudioContext()
      const ctx = audioCtx.current
      [[880,0],[660,0.2],[880,0.4],[660,0.6]].forEach(([freq, t]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = 'sawtooth'; osc.frequency.value = freq
        gain.gain.setValueAtTime(0.2, ctx.currentTime + t)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18)
        osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.22)
      })
    } catch (_) {}
  }, [])

  const stopAlarm = useCallback(() => {
    clearInterval(alarmTimer.current)
    setAlarmBanner(false)
  }, [])

  // ── Leak popup trigger ────────────────────────────────────────────────
  const triggerLeakPopup = useCallback((fSev, fPpm) => {
    if (cookingRef.current) return
    if (fSev === 'safe') {
      lastPopupSev.current = 'safe'
      setLeakPopup(null)
      return
    }
    if (fSev !== lastPopupSev.current) {
      lastPopupSev.current = fSev
      setLeakPopup({ severity: fSev, ppm: fPpm })
    }
  }, [])

  // ── Main leak event handler ───────────────────────────────────────────
  // Reads ppm_approx from Supabase row (matches firmware field name)
  const handleLeakEvent = useCallback((sev, id, ts, rawPpm, rawAdc) => {
    const fPpm = filterPpm(rawPpm)
    const fSev = deriveSeverity(rawPpm)  // always re-derive — don't trust firmware severity field

    setSeverity(fSev)
    setLastSeen(new Date(ts || Date.now()))
    setCurrentPpm(fPpm)
    if (rawAdc != null) setCurrentRaw(rawAdc)
    if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])

    triggerLeakPopup(fSev, fPpm)

    if (cookingRef.current) {
      setAlarmBanner(false)
      clearInterval(alarmTimer.current)
      return
    }

    if (fSev !== 'safe') {
      const newAlert = {
        id: id || Date.now(),
        severity: fSev,
        time: fmtTime(ts || Date.now()),
        date: fmtDate(ts || Date.now()),
        msg: fSev === 'high'
          ? `CRITICAL leak — ~${fPpm ? Math.round(fPpm) : '?'} ppm`
          : `Gas detected — ~${fPpm ? Math.round(fPpm) : '?'} ppm (early warning)`,
        ppm: fPpm,
        raw: rawAdc,
      }
      setAlerts(prev => [newAlert, ...prev.slice(0, 99)])
      setTotalLeaks(t => t + 1)

      if (fSev === 'high') {
        setAlarmBanner(true)
        playAlarm()
        clearInterval(alarmTimer.current)
        alarmTimer.current = setInterval(playAlarm, 2500)
      }
    } else {
      setAlarmBanner(false)
      clearInterval(alarmTimer.current)
    }
  }, [playAlarm, triggerLeakPopup])

  // ── Data init + realtime subscriptions ───────────────────────────────
  useEffect(() => {
    if (demoMode) {
      setTimeout(() => setLoaded(true), 280)
      const DL = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
      setWeeklyLeaksBySev(DL.map((l, i) => ({ label: l, high: [0,1,0,0,1,0,0][i], low: [0,2,1,0,2,1,0][i] })))
      setWeeklyPpm(DL.map((l, i) => ({ label: l, value: [0,320,0,0,460,0,0][i] })))
      setWeeklyUsage(DL.map((l, i) => ({ label: l, value: [68,65,63,61,58,56,57][i] })))
      setRawWeightG(11400)
      setLevelHistory([68,65,63,61,58,56,57])
      setCurrentPpm(null); setCurrentRaw(185)
      setAvgPpm7d(null); setMaxPpm7d(1200)
      setHighLeaks7d(2); setLowLeaks7d(5)
      setPpmHistory([0,0,0,280,0,0,1200,0,0,0,0,0])
      setAlerts([
        { id:1, severity:'high', time:'10:24:15', date:'Jun 3', msg:'CRITICAL leak — ~1200 ppm', ppm:1200 },
        { id:2, severity:'low',  time:'08:12:03', date:'Jun 3', msg:'Gas detected — ~320 ppm (early warning)', ppm:320 },
        { id:3, severity:'low',  time:'22:05:41', date:'Jun 2', msg:'Gas detected — ~280 ppm (early warning)', ppm:280 },
      ])
      setTotalLeaks(7); setConnected(false)

      const iv = setInterval(() => {
        setRawWeightG(prev => {
          const nw = genDemoWeight(prev)
          const pr = cylinderPresetRef.current
          const ct = customTareRef.current
          setLevelHistory(h => [...h.slice(-59), weightToPercent(nw, pr, ct)])
          return nw
        })
        const idx    = demoTick++ % DEMO_CYCLE_SEVS.length
        const rawPpm = DEMO_CYCLE_PPM[idx]
        const fPpm   = filterPpm(rawPpm)
        const fSev   = deriveSeverity(rawPpm)
        setSeverity(fSev)
        setCurrentPpm(fPpm)
        if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])
        setLastSeen(new Date())
        triggerLeakPopup(fSev, fPpm)
        if (!cookingRef.current && fSev !== 'safe') {
          const a = {
            id: Date.now(), severity: fSev, ppm: fPpm,
            time: fmtTime(Date.now()), date: fmtDate(Date.now()),
            msg: fSev === 'high'
              ? `CRITICAL leak — ~${fPpm ? Math.round(fPpm) : '?'} ppm`
              : `Gas detected — ~${fPpm ? Math.round(fPpm) : '?'} ppm (early warning)`,
          }
          setAlerts(p => [a, ...p.slice(0, 99)])
          setTotalLeaks(t => t + 1)
          if (fSev === 'high') {
            setAlarmBanner(true); playAlarm()
            clearInterval(alarmTimer.current)
            alarmTimer.current = setInterval(playAlarm, 2500)
          }
        } else if (fSev === 'safe') {
          setAlarmBanner(false); clearInterval(alarmTimer.current)
        }
      }, 3500)

      return () => { clearInterval(iv); clearInterval(alarmTimer.current) }
    }

    // ── Live mode ──
    // All Supabase queries use exact column names from the firmware:
    //   gas_levels:    weight_grams, created_at
    //   gas_leakages:  id, severity, raw_value, ppm_approx, created_at
    let levelCh, leakCh

    async function init() {
      // Load recent gas levels
      const { data: lvls, error: lvlErr } = await supabase
        .from('gas_levels')
        .select('weight_grams,created_at')
        .order('created_at', { ascending: false })
        .limit(60)

      if (lvlErr) console.error('[GasWatch] gas_levels fetch error:', lvlErr.message)

      if (lvls?.length > 0) {
        const pr = cylinderPresetRef.current
        const ct = customTareRef.current
        setRawWeightG(Number(lvls[0].weight_grams))
        setLastSeen(new Date(lvls[0].created_at))
        setConnected(true)
        setLevelHistory(lvls.map(r => weightToPercent(Number(r.weight_grams), pr, ct)).reverse())
      }

      // Load recent leakage events — field: ppm_approx (matches firmware doc["ppm_approx"])
      const { data: leaks, error: leakErr } = await supabase
        .from('gas_leakages')
        .select('id,severity,raw_value,ppm_approx,created_at')
        .order('created_at', { ascending: false })
        .limit(100)

      if (leakErr) console.error('[GasWatch] gas_leakages fetch error:', leakErr.message)

      if (leaks?.length > 0) {
        const l    = leaks[0]
        const fSev = deriveSeverity(l.ppm_approx)
        const fPpm = filterPpm(l.ppm_approx)
        setSeverity(fSev)
        setCurrentPpm(fPpm)
        if (l.raw_value != null) setCurrentRaw(l.raw_value)
        setPpmHistory(leaks.slice(0, 60).map(r => filterPpm(r.ppm_approx) ?? 0).reverse())
        const nonSafe = leaks.filter(r => deriveSeverity(r.ppm_approx) !== 'safe')
        setAlerts(nonSafe.map(r => ({
          id: r.id,
          severity: deriveSeverity(r.ppm_approx),
          time: fmtTime(r.created_at),
          date: fmtDate(r.created_at),
          msg: deriveSeverity(r.ppm_approx) === 'high'
            ? `CRITICAL leak — ~${r.ppm_approx ? Math.round(r.ppm_approx) : '?'} ppm`
            : `Gas detected — ~${r.ppm_approx ? Math.round(r.ppm_approx) : '?'} ppm (early warning)`,
          ppm: filterPpm(r.ppm_approx),
          raw: r.raw_value,
        })))
        setTotalLeaks(nonSafe.length)
        setConnected(true)
      }

      // 7-day analytics
      const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      const { data: wLvls } = await supabase
        .from('gas_levels').select('weight_grams,created_at').gte('created_at', sevenAgo)
      const sums = Object.fromEntries(DAYS.map(d => [d, 0]))
      const cnts = Object.fromEntries(DAYS.map(d => [d, 0]))
      wLvls?.forEach(r => {
        const d = DAYS[new Date(r.created_at).getDay()]
        sums[d] += weightToPercent(Number(r.weight_grams), cylinderPresetRef.current, customTareRef.current)
        cnts[d]++
      })
      setWeeklyUsage(DAYS.map(d => ({ label: d.slice(0,3), value: cnts[d] > 0 ? Math.round(sums[d]/cnts[d]) : 0 })))

      const { data: wLeaks } = await supabase
        .from('gas_leakages').select('severity,ppm_approx,created_at').gte('created_at', sevenAgo)
      const bySev = Object.fromEntries(DAYS.map(d => [d, { high:0, low:0 }]))
      const ppmS  = Object.fromEntries(DAYS.map(d => [d, 0]))
      const ppmC  = Object.fromEntries(DAYS.map(d => [d, 0]))
      let sumP=0, cntP=0, maxP=0, cH=0, cL=0
      wLeaks?.forEach(r => {
        const d    = DAYS[new Date(r.created_at).getDay()]
        const fSev = deriveSeverity(r.ppm_approx)
        const fPpm = filterPpm(r.ppm_approx)
        if (fSev === 'high') { bySev[d].high++; cH++ }
        if (fSev === 'low')  { bySev[d].low++;  cL++ }
        if (fPpm != null) { ppmS[d]+=fPpm; ppmC[d]++; sumP+=fPpm; cntP++; if(fPpm>maxP) maxP=fPpm }
      })
      setWeeklyLeaksBySev(DAYS.map(d => ({ label: d.slice(0,3), ...bySev[d] })))
      setWeeklyPpm(DAYS.map(d => ({ label: d.slice(0,3), value: ppmC[d]>0 ? Math.round(ppmS[d]/ppmC[d]) : 0 })))
      setAvgPpm7d(cntP > 0 ? Math.round(sumP/cntP) : null)
      setMaxPpm7d(maxP > 0 ? Math.round(maxP) : null)
      setHighLeaks7d(cH); setLowLeaks7d(cL)
      setLoaded(true)
    }

    init()

    if (supabase) {
      levelCh = supabase.channel('rt-levels')
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'gas_levels' }, p => {
          const w  = Number(p.new.weight_grams)
          const pr = cylinderPresetRef.current
          const ct = customTareRef.current
          setRawWeightG(w)
          setLastSeen(new Date(p.new.created_at))
          setConnected(true)
          setLevelHistory(prev => [...prev.slice(-59), weightToPercent(w, pr, ct)])
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') console.log('[GasWatch] Realtime: gas_levels subscribed')
          if (status === 'CHANNEL_ERROR') console.error('[GasWatch] Realtime: gas_levels channel error — check Supabase Realtime is enabled')
        })

      // Realtime for gas_leakages — reads ppm_approx and raw_value (firmware field names)
      leakCh = supabase.channel('rt-leakages')
        .on('postgres_changes', { event:'INSERT', schema:'public', table:'gas_leakages' }, p => {
          handleLeakEvent(
            p.new.severity,   // text: "safe" | "low" | "high"
            p.new.id,
            p.new.created_at,
            p.new.ppm_approx, // int: calculated LPG ppm
            p.new.raw_value   // int: ADC reading 0-4095
          )
          setConnected(true)
        })
        .subscribe(status => {
          if (status === 'SUBSCRIBED') console.log('[GasWatch] Realtime: gas_leakages subscribed')
          if (status === 'CHANNEL_ERROR') console.error('[GasWatch] Realtime: gas_leakages channel error — check Supabase Realtime is enabled')
        })
    }

    return () => {
      supabase?.removeChannel(levelCh)
      supabase?.removeChannel(leakCh)
      clearInterval(alarmTimer.current)
    }
  }, [demoMode, handleLeakEvent, playAlarm, triggerLeakPopup])

  // ── Derived display values ────────────────────────────────────────────
  const displaySev    = cookingMode ? 'safe' : severity
  const displayPpm    = cookingMode ? null   : currentPpm
  const sCol          = cookingMode ? C.safe : C[severity]
  const lCol          = levelColor(gasLevel)
  const rules         = getRecommendations(displaySev, gasLevel, displayPpm)
  const estDays       = useMemo(() => estimateDays(gasLevel, levelHistory), [gasLevel, levelHistory])
  const nonSafeAlerts = useMemo(() => alerts.filter(a => a.severity !== 'safe'), [alerts])

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '◈' },
    { id: 'alerts',    label: 'Alerts',    icon: '◉', badge: nonSafeAlerts.length },
    { id: 'analytics', label: 'Analytics', icon: '◎' },
    { id: 'device',    label: 'Device',    icon: '◇' },
  ]

  if (!loaded) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center',
        justifyContent:'center', flexDirection:'column', gap:16, background:'var(--bg)' }}>
      <div style={{ width:36, height:36, border:'2.5px solid var(--border2)',
          borderTopColor:'#00e5a0', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-3)',
          letterSpacing:'0.12em' }}>INITIALISING</span>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)', display:'flex',
        flexDirection:'column', width:'100%', maxWidth:'100%', overflowX:'hidden' }}>

      {leakPopup && !cookingMode && (
        <LeakAlertPopup
          severity={leakPopup.severity}
          ppm={leakPopup.ppm}
          gasLevel={gasLevel}
          onDismiss={() => setLeakPopup(null)}
        />
      )}

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header style={{
        position:'sticky', top:0, zIndex:200,
        background:'rgba(10,14,26,0.94)', backdropFilter:'blur(18px)',
        borderBottom:'1px solid var(--border)',
        padding:'0 16px', height:56,
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:8,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:9, flexShrink:0 }}>
          <div style={{ width:30, height:30, borderRadius:9,
              background:'linear-gradient(135deg,#ff6b35,#ff4560)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:15, boxShadow:'0 0 14px rgba(255,69,96,0.35)' }}>🔥</div>
          <div>
            <div style={{ fontFamily:'var(--font-disp)', fontSize:16, fontWeight:800,
                lineHeight:1, letterSpacing:'-0.02em' }}>
              GasWatch <span style={{ color:'#4d8eff' }}>Pro</span>
            </div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:8, color:'var(--text-3)',
                letterSpacing:'0.12em' }}>
              {demoMode ? 'DEMO MODE' : 'LIVE · IOT MONITORING'}
            </div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
          <CookingModeToggle active={cookingMode}
            onToggle={() => setCookingMode(!cookingMode)}
            cookingStart={cookingStart} />
          <div style={{ display:'flex', alignItems:'center', gap:4, padding:'3px 8px',
              borderRadius:20, background:'var(--surface2)', border:'1px solid var(--border)' }}>
            <StatusDot online={connected} />
            <span style={{ fontFamily:'var(--font-mono)', fontSize:9,
                color: connected ? '#00e5a0' : '#ff4560' }}>
              {connected ? 'LIVE' : demoMode ? 'DEMO' : 'OFFLINE'}
            </span>
          </div>
          <Chip label={displaySev.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </div>
      </header>

      {/* ── COOKING BANNER ─────────────────────────────────────── */}
      {cookingMode && (
        <div style={{
          position:'sticky', top:56, zIndex:190,
          background:'rgba(255,176,32,0.10)', borderBottom:'1px solid rgba(255,176,32,0.25)',
          padding:'9px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between', gap:8,
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:16 }}>🍳</span>
            <div>
              <div style={{ fontFamily:'var(--font-disp)', fontWeight:700,
                  color:'#ffb020', fontSize:12 }}>Cooking Mode — MQ6 alerts paused</div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:9,
                  color:'rgba(255,176,32,0.7)', marginTop:1 }}>Alerts resume when you turn this off · auto-off after 2 hours</div>
            </div>
          </div>
          <button onClick={() => setCookingMode(false)} style={{ padding:'4px 10px',
              borderRadius:8, fontSize:11, fontWeight:600, cursor:'pointer',
              background:'rgba(255,176,32,0.2)', border:'1px solid rgba(255,176,32,0.4)',
              color:'#ffb020' }}>Off</button>
        </div>
      )}

      {/* ── CRITICAL ALARM BANNER ──────────────────────────────── */}
      {alarmBanner && !cookingMode && (
        <div style={{
          position:'sticky', top:56, zIndex:190,
          background:'rgba(255,69,96,0.13)', borderBottom:'1px solid rgba(255,69,96,0.3)',
          padding:'10px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between', gap:8,
          animation:'shimmer 0.8s ease infinite',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ fontSize:22, flexShrink:0 }}>🚨</span>
            <div>
              <div style={{ fontFamily:'var(--font-disp)', fontWeight:700,
                  color:'#ff4560', fontSize:13 }}>
                CRITICAL LEAK{currentPpm ? ` · ~${Math.round(currentPpm)} ppm` : ''}
              </div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:9,
                  color:'rgba(255,69,96,0.85)', marginTop:1 }}>
                Evacuate · Cut mains power · Call emergency services
              </div>
            </div>
          </div>
          <div style={{ display:'flex', gap:6, flexShrink:0 }}>
            <button onClick={() => setLeakPopup({ severity:'high', ppm:currentPpm })}
              style={{ padding:'5px 10px', borderRadius:8, fontSize:11, fontWeight:600,
                  background:'rgba(255,69,96,0.18)', border:'1px solid rgba(255,69,96,0.4)',
                  color:'#ff4560', cursor:'pointer', whiteSpace:'nowrap' }}>
              Actions
            </button>
            <button onClick={stopAlarm}
              style={{ padding:'5px 12px', borderRadius:8, fontSize:11, fontWeight:700,
                  background:'#ff4560', color:'#fff', cursor:'pointer',
                  boxShadow:'0 0 14px rgba(255,69,96,0.5)', whiteSpace:'nowrap' }}>
              Silence
            </button>
          </div>
        </div>
      )}

      {/* ── LOW LEAK BANNER ────────────────────────────────────── */}
      {!cookingMode && displaySev === 'low' && !alarmBanner && (
        <div style={{
          position:'sticky', top:56, zIndex:185,
          background:'rgba(255,176,32,0.10)', borderBottom:'1px solid rgba(255,176,32,0.28)',
          padding:'9px 16px', display:'flex', alignItems:'center',
          justifyContent:'space-between', gap:8,
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:16, animation:'pulseAmber 1.8s ease infinite' }}>⚠️</span>
            <div>
              <div style={{ fontFamily:'var(--font-disp)', fontWeight:700, color:'#ffb020', fontSize:12 }}>
                Gas detected{currentPpm ? ` · ~${Math.round(currentPpm)} ppm` : ' · early warning'}
              </div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:9,
                  color:'rgba(255,176,32,0.8)', marginTop:1 }}>
                Ventilate now · Check valve and hose connections
              </div>
            </div>
          </div>
          <button onClick={() => setLeakPopup({ severity:'low', ppm:currentPpm })}
            style={{ padding:'4px 10px', borderRadius:8, fontSize:11, fontWeight:600,
                background:'rgba(255,176,32,0.2)', border:'1px solid rgba(255,176,32,0.4)',
                color:'#ffb020', cursor:'pointer', whiteSpace:'nowrap' }}>
            Actions
          </button>
        </div>
      )}

      {/* ── DESKTOP TAB NAV ────────────────────────────────────── */}
      <nav id="desktop-nav" style={{
        background:'rgba(10,14,26,0.82)', backdropFilter:'blur(12px)',
        borderBottom:'1px solid var(--border)',
        padding:'0 12px', overflowX:'auto', WebkitOverflowScrolling:'touch',
      }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            padding:'14px 18px', fontSize:13, fontWeight:600, fontFamily:'var(--font-body)',
            cursor:'pointer',
            color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
            borderBottom: `2px solid ${tab === n.id ? '#4d8eff' : 'transparent'}`,
            borderRadius:0, whiteSpace:'nowrap', transition:'color 0.2s',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <span>{n.icon}</span>{n.label}
            {n.badge > 0 && (
              <span style={{ background:'#ff4560', color:'#fff', fontSize:9, fontWeight:700,
                  borderRadius:10, padding:'1px 5px', fontFamily:'var(--font-mono)' }}>
                {n.badge > 99 ? '99+' : n.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* ── MAIN CONTENT ───────────────────────────────────────── */}
      <main id="main-content" className="fade-up" style={{ flex:1, padding:'16px',
          maxWidth:960, width:'100%', margin:'0 auto', minWidth:0, overflowX:'hidden',
          paddingBottom:80 }}>
        {tab === 'dashboard' && (
          <DashboardTab
            gasLevel={gasLevel} lCol={lCol} rawWeightG={rawWeightG}
            cylinderPreset={cylinderPreset} customTare_g={customTare_g}
            levelHistory={levelHistory} displaySev={displaySev} displayPpm={displayPpm}
            currentPpm={currentPpm} sCol={sCol} ppmHistory={ppmHistory}
            cookingMode={cookingMode} estDays={estDays} totalLeaks={totalLeaks} rules={rules}
          />
        )}
        {tab === 'alerts' && (
          <AlertsTab
            nonSafeAlerts={nonSafeAlerts}
            setAlerts={setAlerts}
            setTotalLeaks={setTotalLeaks}
          />
        )}
        {tab === 'analytics' && (
          <AnalyticsTab
            estDays={estDays} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d}
            highLeaks7d={highLeaks7d} lowLeaks7d={lowLeaks7d}
            weeklyUsage={weeklyUsage} weeklyLeaksBySev={weeklyLeaksBySev} weeklyPpm={weeklyPpm}
            gasLevel={gasLevel} cylinderPreset={cylinderPreset}
            levelHistory={levelHistory} rawWeightG={rawWeightG} customTare_g={customTare_g}
          />
        )}
        {tab === 'device' && (
          <DeviceTab
            cylinderId={cylinderId} setCylinderId={setCylinderId}
            connected={connected} demoMode={demoMode} lastSeen={lastSeen}
            displaySev={displaySev} displayPpm={displayPpm} currentRaw={currentRaw}
            cookingMode={cookingMode} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d} sCol={sCol}
            rawWeightG={rawWeightG} cylinderPreset={cylinderPreset}
            customTare_g={customTare_g} setCustomTare={setCustomTare} gasLevel={gasLevel}
          />
        )}
      </main>

      {/* ── MOBILE BOTTOM NAV ──────────────────────────────────── */}
      <nav id="mobile-nav" style={{
        position:'fixed', bottom:0, left:0, right:0, zIndex:200,
        background:'rgba(10,14,26,0.97)', backdropFilter:'blur(16px)',
        borderTop:'1px solid var(--border)',
        paddingBottom:'env(safe-area-inset-bottom, 0px)',
      }}>
        <div style={{ display:'flex', height:60 }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex:1, display:'flex', flexDirection:'column', alignItems:'center',
              justifyContent:'center', gap:3, padding:'8px 4px', position:'relative',
              cursor:'pointer',
              color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
              transition:'color 0.2s',
            }}>
              {tab === n.id && (
                <div style={{ position:'absolute', top:6, width:4, height:4,
                    borderRadius:'50%', background:'#4d8eff' }} />
              )}
              <span style={{ fontSize:18, lineHeight:1 }}>{n.icon}</span>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:9,
                  fontWeight:500, letterSpacing:'0.05em' }}>{n.label}</span>
              {n.badge > 0 && (
                <span style={{ position:'absolute', top:8, right:'12%',
                    background:'#ff4560', color:'#fff', fontSize:8, fontWeight:700,
                    borderRadius:8, padding:'0 4px', fontFamily:'var(--font-mono)',
                    minWidth:14, textAlign:'center' }}>
                  {n.badge > 99 ? '99+' : n.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DASHBOARD TAB
// ══════════════════════════════════════════════════════════════════════════
function DashboardTab({ gasLevel, lCol, rawWeightG, cylinderPreset, customTare_g,
  levelHistory, displaySev, displayPpm, currentPpm, sCol, ppmHistory,
  cookingMode, estDays, totalLeaks, rules }) {
  const gasKg = rawWeightG != null ? gasRemainingKg(rawWeightG, cylinderPreset, customTare_g) : 0
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <Card accent={lCol.main} glow={lCol.glow}
          style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'20px 12px' }}>
          <SectionTitle style={{ marginBottom:10 }}>Cylinder Level</SectionTitle>
          <ArcGauge value={gasLevel} color={lCol.main} size={130} />
          <div style={{ marginTop:10, textAlign:'center' }}>
            <Chip
              label={gasLevel < 20 ? '⚠ Replace Now' : gasLevel < 40 ? '⚠ Plan Refill' : '✓ Sufficient'}
              color={lCol.main} border={lCol.border} bg={lCol.dim}
            />
            {rawWeightG != null && (
              <div style={{ marginTop:8, fontFamily:'var(--font-mono)', fontSize:9,
                  color:'var(--text-3)', letterSpacing:'0.06em' }}>
                ~{gasKg.toFixed(2)} kg remaining · {cylinderPreset.label}
              </div>
            )}
          </div>
        </Card>

        <Card accent={sCol.main} glow={displaySev !== 'safe' ? sCol.glow : undefined}
          style={{ display:'flex', flexDirection:'column', alignItems:'center',
              justifyContent:'center', gap:8, padding:'20px 12px' }}>
          <SectionTitle style={{ marginBottom:6 }}>Leak Status</SectionTitle>
          <div style={{
            width:72, height:72, borderRadius:'50%',
            background: sCol.dim, border:`1.5px solid ${sCol.border}`,
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:30,
            boxShadow: displaySev !== 'safe' ? sCol.glow : undefined,
            animation:
              displaySev === 'high' ? 'pulseRed 1.2s ease infinite'  :
              displaySev === 'low'  ? 'pulseAmber 1.8s ease infinite' :
                                      'pulseGreen 3s ease infinite',
          }}>
            {cookingMode ? '🍳' : displaySev === 'high' ? '🚨' : displaySev === 'low' ? '⚠️' : '✅'}
          </div>
          <div style={{ fontFamily:'var(--font-disp)', fontSize:16, fontWeight:800,
              color:sCol.main, textAlign:'center' }}>
            {cookingMode ? 'PAUSED' : displaySev === 'high' ? 'CRITICAL' : displaySev === 'low' ? 'LEAKING' : 'ALL SAFE'}
          </div>
          <Chip label={cookingMode ? 'COOKING' : displaySev.toUpperCase()}
            color={sCol.main} border={sCol.border} bg={sCol.dim} />
          {!cookingMode && currentPpm != null && (
            <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:sCol.main,
                marginTop:2, fontWeight:600 }}>~{Math.round(currentPpm)} ppm</div>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>MQ6 Gas Concentration</SectionTitle>
        <PpmBar ppm={displayPpm} />
        {ppmHistory.filter(v => v > 0).length >= 3 && !cookingMode && (
          <div style={{ marginTop:10 }}>
            <Sparkline data={ppmHistory} color={sCol.main} height={34} />
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)',
                marginTop:3, textAlign:'center', letterSpacing:'0.07em' }}>
              PPM HISTORY (≥{LPG_PPM_LOW} ppm only)
            </div>
          </div>
        )}
      </Card>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
        {[
          { label:'Est. Days Left', val:`~${estDays}d`,             col:'#4d8eff'  },
          { label:'Gas Level',      val:`${Math.round(gasLevel)}%`, col:lCol.main  },
          { label:'Leak Events',    val:totalLeaks,                 col:'#ff4560'  },
        ].map((s, i) => (
          <Card key={i} style={{ textAlign:'center', padding:'14px 8px' }}>
            <div style={{ fontFamily:'var(--font-disp)', fontSize:24, fontWeight:800,
                color:s.col, lineHeight:1 }}>{s.val}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)',
                marginTop:6, letterSpacing:'0.06em', textTransform:'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>

      {levelHistory.length >= 3 && (
        <Card>
          <SectionTitle>Cylinder Level Trend · Last {Math.min(levelHistory.length,60)} Readings</SectionTitle>
          <Sparkline data={levelHistory} color={lCol.main} height={52} />
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:6,
              fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)' }}>
            <span>oldest</span>
            <span>current: {Math.round(gasLevel)}%</span>
          </div>
        </Card>
      )}

      <Card accent={sCol.main}>
        <SectionTitle>
          {displaySev === 'high' ? '🚨 URGENT — Safety Actions' :
           displaySev === 'low'  ? '⚠️ Safety Recommendations' :
           '⚡ Safety Recommendations'}
        </SectionTitle>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {rules.map((r, i) => (
            <div key={i} style={{
              padding:'10px 12px', borderRadius:'var(--r-sm)',
              background: r.urgent ? sCol.dim : 'var(--surface2)',
              border:`1px solid ${r.urgent ? sCol.border : 'var(--border)'}`,
              display:'flex', alignItems:'flex-start', gap:10,
            }}>
              <span style={{ fontSize:15, flexShrink:0, marginTop:1 }}>{r.icon}</span>
              <span style={{ fontFamily:'var(--font-body)', fontSize:13, lineHeight:1.5,
                  color: r.urgent ? sCol.main : 'var(--text-2)',
                  fontWeight: r.urgent ? 600 : 400 }}>{r.text}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ALERTS TAB
// ══════════════════════════════════════════════════════════════════════════
function AlertsTab({ nonSafeAlerts, setAlerts, setTotalLeaks }) {
  const handleClear = () => { setAlerts([]); setTotalLeaks(0) }
  return (
    <Card>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start',
          marginBottom:18, gap:12, flexWrap:'wrap' }}>
        <div>
          <SectionTitle style={{ marginBottom:4 }}>Alert History · MQ6</SectionTitle>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-3)' }}>
            {nonSafeAlerts.length} event{nonSafeAlerts.length !== 1 ? 's' : ''} · ≥{LPG_PPM_LOW} ppm threshold
          </div>
        </div>
        {nonSafeAlerts.length > 0 && (
          <button onClick={handleClear}
            style={{ padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:600,
                background:'var(--surface2)', border:'1px solid var(--border)',
                color:'var(--text-2)', flexShrink:0, cursor:'pointer' }}>
            Clear All
          </button>
        )}
      </div>

      {nonSafeAlerts.length === 0 ? (
        <div style={{ textAlign:'center', padding:'52px 20px', color:'var(--text-3)' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🛡️</div>
          <div style={{ fontFamily:'var(--font-body)', fontSize:14, marginBottom:5,
              color:'var(--text-2)' }}>No leakage events recorded</div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>
            All MQ6 readings below {LPG_PPM_LOW} ppm
          </div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {nonSafeAlerts.map(a => {
            const ac = C[a.severity]
            return (
              <div key={a.id} style={{
                padding:'12px 14px', borderRadius:'var(--r-sm)',
                background:ac.dim, border:`1px solid ${ac.border}`,
                display:'flex', justifyContent:'space-between', alignItems:'center',
                gap:10, minWidth:0,
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0, flex:1 }}>
                  <span style={{ fontSize:18, flexShrink:0 }}>
                    {a.severity === 'high' ? '🚨' : '⚠️'}
                  </span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontFamily:'var(--font-body)', fontSize:13,
                        fontWeight:600, color:ac.main }}>{a.msg}</div>
                    <div style={{ fontFamily:'var(--font-mono)', fontSize:10,
                        color:'var(--text-3)', marginTop:3, display:'flex',
                        gap:8, flexWrap:'wrap' }}>
                      <span>{a.date} · {a.time}</span>
                      {a.ppm != null && (
                        <span style={{ color:ac.main }}>~{Math.round(a.ppm)} ppm</span>
                      )}
                    </div>
                  </div>
                </div>
                <Chip label={a.severity.toUpperCase()}
                  color={ac.main} border={ac.border} bg={ac.dim} style={{ flexShrink:0 }} />
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ══════════════════════════════════════════════════════════════════════════
function AnalyticsTab({ estDays, avgPpm7d, maxPpm7d, highLeaks7d, lowLeaks7d,
  weeklyUsage, weeklyLeaksBySev, weeklyPpm, gasLevel, cylinderPreset,
  levelHistory, rawWeightG, customTare_g }) {
  const lCol    = levelColor(gasLevel)
  const gasKg   = rawWeightG != null ? gasRemainingKg(rawWeightG, cylinderPreset, customTare_g) : 0
  const statRows = [
    { label:'Est. Days Left',  val:`~${estDays}d`,                                col:'#00e5a0' },
    { label:'Gas Remaining',   val:`${Math.round(gasLevel)}% · ${gasKg.toFixed(1)}kg`, col:lCol.main },
    { label:'Avg PPM (7d)',    val:avgPpm7d  != null ? `${avgPpm7d} ppm`  : '—',  col:'#ffb020' },
    { label:'Peak PPM (7d)',   val:maxPpm7d  != null ? `${maxPpm7d} ppm`  : '—',  col:'#ff4560' },
    { label:'Critical Events', val:highLeaks7d,                                    col:'#ff4560' },
    { label:'Warning Events',  val:lowLeaks7d,                                     col:'#ffb020' },
  ]
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:10 }}>
        {statRows.map((s, i) => (
          <Card key={i} style={{ textAlign:'center', padding:'16px 10px' }}>
            <div style={{ fontFamily:'var(--font-disp)', fontSize:24, fontWeight:800,
                color:s.col, lineHeight:1 }}>{s.val}</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)',
                marginTop:8, letterSpacing:'0.06em', textTransform:'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>

      <Card>
        <SectionTitle>Daily Average Gas Level (7d)</SectionTitle>
        <BarChart data={weeklyUsage} color="#4d8eff" showValues />
        <div style={{ marginTop:8, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>
          {cylinderPreset.label} cylinder · ~{estDays} days at current usage
        </div>
      </Card>

      <Card>
        <SectionTitle>Leak Events by Day (7d)</SectionTitle>
        <DualBarChart data={weeklyLeaksBySev} showValues />
        <div style={{ marginTop:8, fontFamily:'var(--font-mono)', fontSize:10,
            color:'var(--text-3)', display:'flex', gap:12, flexWrap:'wrap' }}>
          <span>Critical (≥1000 ppm): <span style={{ color:'#ff4560' }}>{highLeaks7d}</span></span>
          <span>Warning (200–999 ppm): <span style={{ color:'#ffb020' }}>{lowLeaks7d}</span></span>
        </div>
      </Card>

      <Card>
        <SectionTitle>Average PPM by Day (7d · ≥{LPG_PPM_LOW} ppm only)</SectionTitle>
        <BarChart data={weeklyPpm} color="#ffb020" showValues />
        <div style={{ display:'flex', justifyContent:'space-between', marginTop:8,
            fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)',
            flexWrap:'wrap', gap:8 }}>
          <span>7d avg: <span style={{ color:'#ffb020' }}>{avgPpm7d != null ? `${avgPpm7d} ppm` : '—'}</span></span>
          <span>peak: <span style={{ color: maxPpm7d >= LPG_PPM_HIGH ? '#ff4560' : '#ffb020' }}>
            {maxPpm7d != null ? `${maxPpm7d} ppm` : '—'}
          </span></span>
        </div>
      </Card>

      {levelHistory.length >= 3 && (
        <Card>
          <SectionTitle>Gas Level Trend · Last {Math.min(levelHistory.length,60)} Readings</SectionTitle>
          <div style={{ height:84 }}><Sparkline data={levelHistory} color={lCol.main} height={84} /></div>
          <div style={{ display:'flex', justifyContent:'space-between', marginTop:6,
              fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)',
              flexWrap:'wrap', gap:8 }}>
            <span>oldest</span>
            <span>now: {Math.round(gasLevel)}% (~{gasKg.toFixed(2)} kg remaining)</span>
          </div>
        </Card>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DEVICE TAB
// ══════════════════════════════════════════════════════════════════════════
function DeviceTab({ cylinderId, setCylinderId, connected, demoMode, lastSeen,
  displaySev, displayPpm, currentRaw, cookingMode, avgPpm7d, maxPpm7d, sCol,
  rawWeightG, cylinderPreset, customTare_g, setCustomTare, gasLevel }) {

  const [tareInput, setTareInput] = useState(
    customTare_g != null ? String(customTare_g / 1000) : ''
  )
  const [tareMsg, setTareMsg] = useState(null)

  const usingCustomTare = customTare_g != null
  const activeTare      = usingCustomTare ? customTare_g : cylinderPreset.tare_g
  const modeColor       = usingCustomTare ? '#00e5a0' : '#ffb020'
  const modeLabel       = usingCustomTare
    ? `Custom tare: ${(customTare_g / 1000).toFixed(2)} kg (your calibration)`
    : `Preset tare: ${(cylinderPreset.tare_g / 1000).toFixed(0)} kg (${cylinderPreset.label} standard)`

  const showMsg = (text, ok, ms = 4000) => {
    setTareMsg({ text, ok })
    setTimeout(() => setTareMsg(null), ms)
  }

  const handleSaveTare = () => {
    const kg = parseFloat(tareInput)
    if (isNaN(kg) || kg < 1 || kg > 30) {
      showMsg('Enter a valid tare between 1–30 kg', false); return
    }
    setCustomTare(kg * 1000)
    showMsg(`✓ Tare set to ${kg.toFixed(2)} kg — gauge updated`, true)
  }

  const handleClearTare = () => {
    setCustomTare(null); setTareInput('')
    showMsg('Custom tare cleared — using preset', true, 3000)
  }

  const handleStampTare = () => {
    if (rawWeightG == null) return
    const kg = rawWeightG / 1000
    setTareInput(kg.toFixed(3))
    setCustomTare(rawWeightG)
    showMsg(`✓ Tare stamped at ${kg.toFixed(3)} kg (current live reading)`, true)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>

      <Card>
        <CylinderSelector selectedId={cylinderId} onChange={setCylinderId} />
      </Card>

      <Card accent="#4d8eff">
        <SectionTitle>⚖️ Load Cell Calibration</SectionTitle>

        <div style={{ padding:'10px 14px', borderRadius:'var(--r-sm)', marginBottom:16,
            background:'var(--surface2)', border:`1px solid ${modeColor}44`,
            display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background:modeColor,
              flexShrink:0, boxShadow:`0 0 8px ${modeColor}` }} />
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:modeColor,
                fontWeight:600, letterSpacing:'0.05em' }}>ACTIVE TARE MODE</div>
            <div style={{ fontFamily:'var(--font-body)', fontSize:13,
                color:'var(--text-1)', marginTop:2 }}>{modeLabel}</div>
          </div>
          <div style={{ textAlign:'right', flexShrink:0 }}>
            <div style={{ fontFamily:'var(--font-disp)', fontSize:22, fontWeight:800,
                color:'#4d8eff', lineHeight:1 }}>{Math.round(gasLevel)}%</div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9,
                color:'var(--text-3)', marginTop:2 }}>gas level</div>
          </div>
        </div>

        {rawWeightG != null && (
          <div style={{ padding:'10px 14px', borderRadius:'var(--r-sm)', marginBottom:16,
              background:'var(--surface3)', border:'1px solid var(--border)',
              display:'flex', flexDirection:'column', gap:8 }}>
            <div style={{ display:'flex', justifyContent:'space-between',
                alignItems:'center', flexWrap:'wrap', gap:8 }}>
              <span style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)' }}>
                Sensor reading (board tare subtracted by firmware)
              </span>
              <span style={{ fontFamily:'var(--font-disp)', fontSize:16, fontWeight:800, color:'var(--text-1)' }}>
                {(rawWeightG/1000).toFixed(3)} kg
                <span style={{ fontFamily:'var(--font-mono)', fontSize:10,
                    color:'var(--text-3)', marginLeft:6, fontWeight:400 }}>
                  ({Math.round(rawWeightG)} g)
                </span>
              </span>
            </div>
            <div style={{ display:'flex', justifyContent:'space-between',
                alignItems:'center', flexWrap:'wrap', gap:8,
                paddingTop:8, borderTop:'1px solid var(--border)' }}>
              <span style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)' }}>
                Gas remaining (sensor − tare {(activeTare/1000).toFixed(2)} kg)
              </span>
              <span style={{ fontFamily:'var(--font-disp)', fontSize:16, fontWeight:800, color:'#00e5a0' }}>
                ~{gasRemainingKg(rawWeightG, cylinderPreset, customTare_g).toFixed(2)} kg
                <span style={{ fontFamily:'var(--font-mono)', fontSize:10,
                    color:'var(--text-3)', marginLeft:6, fontWeight:400 }}>
                  ({Math.round(gasLevel)}%)
                </span>
              </span>
            </div>
          </div>
        )}

        <div style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-2)',
            lineHeight:1.65, marginBottom:16 }}>
          The ESP32 firmware subtracts the wooden board weight automatically and always posts
          <strong style={{ color:'var(--text-1)' }}> cylinder body + gas weight</strong> as
          <code style={{ fontFamily:'var(--font-mono)', fontSize:12 }}> weight_grams</code>.
          Set the tare below so the app can calculate actual gas remaining correctly.
        </div>

        {rawWeightG != null && (
          <div style={{ padding:'12px 14px', borderRadius:'var(--r-sm)', marginBottom:12,
              background:'rgba(0,229,160,0.06)', border:'1px solid rgba(0,229,160,0.2)' }}>
            <div style={{ fontFamily:'var(--font-body)', fontSize:13, fontWeight:600,
                color:'#00e5a0', marginBottom:4 }}>Option A — Empty cylinder on the scale now?</div>
            <div style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)',
                lineHeight:1.5, marginBottom:10 }}>
              Place your <strong style={{ color:'var(--text-2)' }}>completely empty</strong> cylinder
              on the scale, wait for the reading to stabilise, then tap below.
            </div>
            <button onClick={handleStampTare} style={{
              padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:700, cursor:'pointer',
              background:'rgba(0,229,160,0.15)', border:'1px solid rgba(0,229,160,0.4)',
              color:'#00e5a0', letterSpacing:'0.03em',
            }}>
              📍 Stamp {rawWeightG != null ? `${(rawWeightG/1000).toFixed(3)} kg` : '—'} as tare
            </button>
          </div>
        )}

        <div style={{ padding:'12px 14px', borderRadius:'var(--r-sm)', marginBottom:12,
            background:'rgba(77,142,255,0.06)', border:'1px solid rgba(77,142,255,0.2)' }}>
          <div style={{ fontFamily:'var(--font-body)', fontSize:13, fontWeight:600,
              color:'#4d8eff', marginBottom:4 }}>Option B — Enter tare weight manually</div>
          <div style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)',
              lineHeight:1.5, marginBottom:10 }}>
            Check the sticker on your cylinder for the value marked
            <strong style={{ color:'var(--text-2)' }}> T </strong> or
            <strong style={{ color:'var(--text-2)' }}> Tare</strong>, and enter it in kg.
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <input type="number" min="1" max="30" step="0.001"
              value={tareInput} onChange={e => setTareInput(e.target.value)}
              placeholder={`e.g. ${(cylinderPreset.tare_g/1000).toFixed(1)}`}
              style={{ flex:1, minWidth:100, padding:'8px 12px', borderRadius:8,
                background:'var(--surface3)', border:'1px solid var(--border2)',
                color:'var(--text-1)', fontFamily:'var(--font-mono)', fontSize:13,
                outline:'none' }}
            />
            <button onClick={handleSaveTare} style={{ padding:'8px 16px', borderRadius:8,
                fontSize:12, fontWeight:700, cursor:'pointer',
                background:'rgba(77,142,255,0.15)', border:'1px solid rgba(77,142,255,0.4)',
                color:'#4d8eff', whiteSpace:'nowrap' }}>Save Tare</button>
            {customTare_g != null && (
              <button onClick={handleClearTare} style={{ padding:'8px 12px', borderRadius:8,
                  fontSize:12, fontWeight:600, cursor:'pointer',
                  background:'var(--surface2)', border:'1px solid var(--border)',
                  color:'var(--text-3)', whiteSpace:'nowrap' }}>Reset</button>
            )}
          </div>
        </div>

        {tareMsg && (
          <div style={{ padding:'10px 14px', borderRadius:'var(--r-sm)', marginBottom:12,
              background: tareMsg.ok ? 'rgba(0,229,160,0.08)' : 'rgba(255,69,96,0.08)',
              border:`1px solid ${tareMsg.ok ? 'rgba(0,229,160,0.3)' : 'rgba(255,69,96,0.3)'}`,
              fontFamily:'var(--font-body)', fontSize:13,
              color: tareMsg.ok ? '#00e5a0' : '#ff4560' }}>
            {tareMsg.text}
          </div>
        )}

        <div style={{ padding:'10px 14px', borderRadius:'var(--r-sm)',
            background:'var(--surface3)', border:'1px solid var(--border)',
            fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', lineHeight:1.8 }}>
          Formula: <span style={{ color:'var(--text-2)' }}>
            (sensor_g − {activeTare}g tare) ÷ {cylinderPreset.net_g}g × 100
          </span> · clamped 0–100%
          <br />
          <span>Full = ({cylinderPreset.tare_g + cylinderPreset.net_g}g − {activeTare}g)
            ÷ {cylinderPreset.net_g}g = 100% ·
            Empty = ({cylinderPreset.tare_g}g − {activeTare}g)
            ÷ {cylinderPreset.net_g}g = {Math.round(((cylinderPreset.tare_g - activeTare) / cylinderPreset.net_g) * 100)}%
          </span>
        </div>
      </Card>

      {/* MQ6 threshold reference — values match firmware constants */}
      <Card accent="#ffb020">
        <SectionTitle>🔬 MQ6 Safety Thresholds (NIOSH/LEL)</SectionTitle>
        {[
          { range:`0 – ${LPG_PPM_LOW - 1} ppm`,        label:'Safe',          col:'#00e5a0', desc:'Below sensor detection floor — normal air' },
          { range:`${LPG_PPM_LOW} – ${LPG_PPM_HIGH - 1} ppm`, label:'Warning ⚠️', col:'#ffb020', desc:'Early accumulation — ventilate immediately, check valve' },
          { range:`${LPG_PPM_HIGH} – 1999 ppm`,         label:'Critical 🚨',   col:'#ff4560', desc:'~5% LEL — ignition risk present, evacuate' },
          { range:'≥ 2000 ppm',                         label:'IDLH / LEL',    col:'#ff4560', desc:'NIOSH emergency level — explosion possible' },
        ].map((row, i, arr) => (
          <div key={i} style={{ display:'flex', justifyContent:'space-between',
              alignItems:'flex-start', padding:'10px 0',
              borderBottom: i < arr.length-1 ? '1px solid var(--border)' : 'none',
              gap:12, flexWrap:'wrap' }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:row.col, fontWeight:600 }}>
                {row.range}
              </div>
              <div style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)', marginTop:2 }}>
                {row.desc}
              </div>
            </div>
            <Chip label={row.label} color={row.col} style={{ flexShrink:0 }} />
          </div>
        ))}
        <div style={{ marginTop:12, padding:'10px 14px', borderRadius:'var(--r-sm)',
            background:'rgba(255,176,32,0.06)', border:'1px solid rgba(255,176,32,0.2)',
            fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', lineHeight:1.7 }}>
          Firmware constants: PPM_SAFE_LIMIT=<span style={{ color:'#00e5a0' }}>{LPG_PPM_LOW}</span> ·
          PPM_LOW_LIMIT=<span style={{ color:'#ff4560' }}>{LPG_PPM_HIGH}</span> ·
          PPM_CHANGE_THRESHOLD=20 (dedup guard)
        </div>
      </Card>

      <Card accent="#4d8eff">
        <SectionTitle>ESP32 Device Status</SectionTitle>
        {[
          { k:'Connection', v: connected ? 'Online' : demoMode ? 'Demo Mode' : 'Offline',
            col: connected ? '#00e5a0' : demoMode ? '#ffb020' : '#ff4560' },
          { k:'Last Data',  v: lastSeen.toLocaleTimeString(),   col:null },
          { k:'Protocol',   v: 'HTTP POST → Supabase REST',     col:null },
          { k:'Send Rate',  v: 'Every 5 s (dedup on change)',   col:null },
          { k:'Firmware',   v: 'GasWatch v2.2.0',               col:'#4d8eff' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display:'flex', justifyContent:'space-between',
              alignItems:'center', padding:'10px 0',
              borderBottom: i < arr.length-1 ? '1px solid var(--border)' : 'none',
              gap:12, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'var(--font-body)', fontSize:13,
                color:'var(--text-3)', flexShrink:0 }}>{r.k}</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:12,
                color: r.col || 'var(--text-2)', textAlign:'right' }}>{r.v}</span>
          </div>
        ))}
      </Card>

      <Card>
        <SectionTitle>Live MQ6 Readings</SectionTitle>
        {[
          { k:'Severity',    v: cookingMode ? 'PAUSED (cooking)' : displaySev.toUpperCase(),
            col: cookingMode ? '#ffb020' : sCol.main },
          { k:'PPM (≥200)', v: displayPpm != null ? `~${Math.round(displayPpm)} ppm` : '< 200 ppm (safe)',
            col: displayPpm ? sCol.main : 'var(--text-3)' },
          { k:'Raw ADC',     v: currentRaw != null ? String(currentRaw) : '—', col:'var(--text-2)' },
          { k:'7d Avg PPM',  v: avgPpm7d  != null ? `${avgPpm7d} ppm`  : '—',  col:'var(--text-2)' },
          { k:'7d Peak PPM', v: maxPpm7d  != null ? `${maxPpm7d} ppm`  : '—',
            col: maxPpm7d >= LPG_PPM_HIGH ? '#ff4560' : maxPpm7d >= LPG_PPM_LOW ? '#ffb020' : 'var(--text-2)' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display:'flex', justifyContent:'space-between',
              padding:'9px 0', borderBottom: i < arr.length-1 ? '1px solid var(--border)' : 'none',
              gap:12, flexWrap:'wrap' }}>
            <span style={{ fontFamily:'var(--font-body)', fontSize:12,
                color:'var(--text-3)', flexShrink:0 }}>{r.k}</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:r.col }}>{r.v}</span>
          </div>
        ))}
      </Card>

      <Card>
        <SectionTitle>Sensor Health</SectionTitle>
        {[
          { name:'HX711 Load Cell', sub:'weight_grams · SPI',      health: connected ? 100 : 0, col:'#4d8eff' },
          { name:'MQ6 Gas Sensor',  sub:'ppm_approx · severity',   health: connected ?  98 : 0, col:'#00e5a0' },
        ].map((s, i) => (
          <div key={i} style={{ padding:'12px', background:'var(--surface2)',
              borderRadius:'var(--r-sm)', border:'1px solid var(--border)',
              marginBottom: i === 0 ? 8 : 0 }}>
            <div style={{ display:'flex', justifyContent:'space-between',
                alignItems:'center', marginBottom:8, gap:10, flexWrap:'wrap' }}>
              <div>
                <div style={{ fontFamily:'var(--font-body)', fontSize:13,
                    fontWeight:600, color:'var(--text-1)' }}>{s.name}</div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:10,
                    color:'var(--text-3)', marginTop:2 }}>{s.sub}</div>
              </div>
              <Chip label={connected ? 'ACTIVE' : 'OFFLINE'}
                color={connected ? '#00e5a0' : '#ff4560'} style={{ flexShrink:0 }} />
            </div>
            <div style={{ background:'var(--surface3)', borderRadius:4, height:5, overflow:'hidden' }}>
              <div style={{ width:`${s.health}%`, height:'100%', background:s.col,
                  borderRadius:4, transition:'width 1s ease' }} />
            </div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)',
                textAlign:'right', marginTop:4 }}>{s.health}%</div>
          </div>
        ))}
      </Card>

      <Card>
        <SectionTitle>Integration Notes</SectionTitle>
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {[
            { icon:'🔗', title:'ESP32 WiFi',
              desc:'Managed by WiFiManager — connect phone to "GasMonitor-Setup" hotspot on first boot, open 192.168.4.1.' },
            { icon:'⚖️', title:'HX711 Load Cell',
              desc:'Firmware subtracts BOARD_WEIGHT_G automatically, posts cylinder + gas weight as weight_grams every 5 s (only when changed by ≥20 g).' },
            { icon:'📊', title:'MQ6 Thresholds',
              desc:`Firmware: safe < ${LPG_PPM_LOW} ppm · low ${LPG_PPM_LOW}–${LPG_PPM_HIGH-1} ppm · high ≥ ${LPG_PPM_HIGH} ppm. Uploads only when severity or ppm changes by ≥20.` },
            { icon:'📍', title:'Sensor Placement',
              desc:'Mount MQ6 low (near floor level) — LPG is heavier than air and sinks. Ideal distance: 20–40 cm from regulator.' },
            { icon:'📡', title:'Supabase Realtime',
              desc:'Enable Realtime replication for both gas_levels and gas_leakages in Supabase → Database → Replication. Check browser console for "SUBSCRIBED" messages.' },
            { icon:'🔑', title:'Environment Variables',
              desc:'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (local) and in Netlify → Site Settings → Environment Variables (deployed). Missing vars = Demo Mode.' },
          ].map((c, i) => (
            <div key={i} style={{ padding:'12px', background:'var(--surface2)',
                borderRadius:'var(--r-sm)', border:'1px solid var(--border)',
                display:'flex', gap:10, alignItems:'flex-start' }}>
              <span style={{ fontSize:17, flexShrink:0 }}>{c.icon}</span>
              <div>
                <div style={{ fontFamily:'var(--font-body)', fontSize:13,
                    fontWeight:600, marginBottom:3 }}>{c.title}</div>
                <div style={{ fontFamily:'var(--font-body)', fontSize:12,
                    color:'var(--text-3)', lineHeight:1.5 }}>{c.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
