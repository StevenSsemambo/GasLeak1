import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase.js'

// ─── Cylinder presets (East Africa standard LPG) ───────────────────────────
// tare_g = weight of the EMPTY cylinder body only (no gas)
// net_g  = weight of gas when full
// total full weight = tare_g + net_g
export const CYLINDER_PRESETS = [
  { id: '3kg',  label: '3 kg',  net_g:  3000, tare_g:  5000 },
  { id: '6kg',  label: '6 kg',  net_g:  6000, tare_g:  8000 },
  { id: '12kg', label: '12 kg', net_g: 12000, tare_g: 14000 },
  { id: '15kg', label: '15 kg', net_g: 15000, tare_g: 17000 },
]
const DEFAULT_CYLINDER = '6kg'

// ─── weightToPercent — handles BOTH total weight and net-gas-only weight ──
// customTare_g: if set (from manual calibration), uses that instead of preset tare
const weightToPercent = (weight_g, preset, customTare_g = null) => {
  if (weight_g == null || !preset) return 0
  const w = parseFloat(weight_g)
  if (isNaN(w)) return 0

  const tare = customTare_g != null ? parseFloat(customTare_g) : preset.tare_g

  // If weight is less than or equal to net_g, the ESP32 is probably sending
  // net gas weight only (already subtracted tare). Use it directly.
  const looksLikeNetOnly = (customTare_g == null) && (w <= preset.net_g * 1.05)

  const gasRemaining = looksLikeNetOnly ? w : (w - tare)
  const raw     = (gasRemaining / preset.net_g) * 100
  const clamped = Math.min(100, Math.max(0, raw))
  return isNaN(clamped) ? 0 : parseFloat(clamped.toFixed(2))
}

// ─── MQ6 thresholds ────────────────────────────────────────────────────────
const LPG_PPM_THRESHOLD = 300
const filterPpm = (ppm) => (ppm != null && ppm >= LPG_PPM_THRESHOLD ? ppm : null)
const filterSeverity = (sev, ppm) => (ppm != null && ppm >= LPG_PPM_THRESHOLD ? sev : 'safe')

// ─── Safety recommendations ────────────────────────────────────────────────
const getRecommendations = (severity, level, ppm) => {
  if (severity === 'high') return [
    { icon: '🚨', text: 'EVACUATE immediately — do not delay', urgent: true },
    { icon: '⚡', text: 'Cut all electrical power at the mains', urgent: true },
    { icon: '🚫', text: 'Do NOT operate switches or appliances', urgent: true },
    { icon: '📞', text: 'Call emergency services immediately', urgent: false },
    { icon: '🪟', text: 'Open all windows and doors if safe', urgent: false },
    ppm && ppm > 800
      ? { icon: '☣️', text: `Extremely high: ~${Math.round(ppm)} ppm — stay clear`, urgent: true }
      : { icon: '📊', text: `MQ6 reading ~${ppm ? Math.round(ppm) : '—'} ppm`, urgent: false },
  ]
  if (severity === 'low') return [
    { icon: '⚠️', text: 'Ventilate now — open windows', urgent: true },
    { icon: '🔍', text: 'Inspect cylinder valve and connections', urgent: false },
    { icon: '🚭', text: 'No flames or ignition sources nearby', urgent: false },
    { icon: '👁️', text: 'Monitor MQ6 readings closely', urgent: false },
    ppm ? { icon: '📊', text: `Current MQ6: ~${Math.round(ppm)} ppm`, urgent: false }
        : { icon: '📊', text: 'Track PPM trend in Analytics', urgent: false },
  ]
  if (level < 20) return [
    { icon: '📦', text: 'Cylinder critically low — arrange refill', urgent: true },
    { icon: '📋', text: 'Contact your gas supplier today', urgent: false },
    { icon: '🕐', text: 'Less than a week of gas remaining', urgent: false },
  ]
  if (level < 40) return [
    { icon: '📦', text: 'Below 40% — schedule refill this week', urgent: false },
    { icon: '📊', text: 'Track usage in the Analytics tab', urgent: false },
  ]
  return [
    { icon: '✅', text: 'System operating normally', urgent: false },
    { icon: '🔍', text: 'Routine monthly inspection due', urgent: false },
  ]
}

// ─── Color tokens ──────────────────────────────────────────────────────────
const C = {
  safe: { main: '#00e5a0', dim: 'rgba(0,229,160,0.10)',  border: 'rgba(0,229,160,0.22)',  glow: '0 0 28px rgba(0,229,160,0.28)' },
  low:  { main: '#ffb020', dim: 'rgba(255,176,32,0.10)', border: 'rgba(255,176,32,0.22)', glow: '0 0 28px rgba(255,176,32,0.28)' },
  high: { main: '#ff4560', dim: 'rgba(255,69,96,0.10)',  border: 'rgba(255,69,96,0.22)',  glow: '0 0 28px rgba(255,69,96,0.38)' },
}
const levelColor = l => l < 20 ? C.high : l < 40 ? C.low : C.safe
const isConfigured = () => !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

// ─── Demo data ─────────────────────────────────────────────────────────────
let demoIdx = 0
const demoSevs = ['safe','safe','safe','safe','low','safe','safe','high','safe','safe','safe','safe']
const demoPpm  = [45, 52, 48, 61, 350, 55, 44, 750, 51, 48, 53, 50]
const genDemoWeight = prev => Math.max(8050, Math.min(14000, (prev ?? 11400) + (Math.random() - 0.52) * 30))

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })

// ─── Shared UI primitives ──────────────────────────────────────────────────────
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

// ─── Arc Gauge ─────────────────────────────────────────────────────────────
function ArcGauge({ value, color, size = 160 }) {
  const r = size * 0.38, cx = size / 2, cy = size / 2
  const startAngle = -210, totalArc = 240
  const safeValue = isNaN(value) || value == null ? 0 : Math.min(100, Math.max(0, value))
  const valueArc = (safeValue / 100) * totalArc
  const toRad = a => (a * Math.PI) / 180
  const arcPath = (startA, endA) => {
    const x1 = cx + r * Math.cos(toRad(startA)), y1 = cy + r * Math.sin(toRad(startA))
    const x2 = cx + r * Math.cos(toRad(endA)),   y2 = cy + r * Math.sin(toRad(endA))
    const la = Math.abs(endA - startA) > 180 ? 1 : 0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${la} 1 ${x2} ${y2}`
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      <path
        d={arcPath(startAngle, startAngle + totalArc)}
        fill="none" stroke="rgba(255,255,255,0.05)"
        strokeWidth={size * 0.07} strokeLinecap="round"
      />
      <path
        d={arcPath(startAngle, startAngle + valueArc)}
        fill="none" stroke={color}
        strokeWidth={size * 0.07} strokeLinecap="round"
        style={{
          filter: `drop-shadow(0 0 6px ${color})`,
          transition: 'all 1s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      />
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

// ─── Enhanced PPM bar with values ───────────────────────────────────────────────────
function PpmBar({ ppm }) {
  const MAX = 1000
  const displayPpm = filterPpm(ppm)
  const pct = Math.min(100, ((displayPpm || 0) / MAX) * 100)
  const col = displayPpm >= 500 ? '#ff4560' : displayPpm >= 300 ? '#ffb020' : '#00e5a0'
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
        <span>MQ6 concentration</span>
        <span style={{ color: displayPpm ? col : 'var(--text-3)', fontWeight: 600 }}>
          {displayPpm != null ? `~${Math.round(displayPpm)} ppm` : '0 ppm'}
        </span>
      </div>
      <div style={{ background: 'var(--surface3)', borderRadius: 6, height: 7, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 6, background: `linear-gradient(90deg, #00e5a0, ${col})`, transition: 'width 1s ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>
        <span>0</span><span>300</span><span>500</span><span>1000 ppm</span>
      </div>
    </div>
  )
}

// ─── Enhanced BarChart with Y-axis and values ─────────────────────────────
function BarChart({ data, color, showValues = true, yAxisLabel = '' }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  
  const max = Math.max(...data.map(d => d.value), 1)
  const barAreaHeight = 100
  const yAxisWidth = 40
  
  // Calculate Y-axis ticks
  const yTicks = [0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max]
  
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* Y-axis labels */}
        <div style={{ 
          width: yAxisWidth, 
          display: 'flex', 
          flexDirection: 'column', 
          justifyContent: 'space-between',
          height: barAreaHeight,
          paddingRight: 8,
          borderRight: '1px solid var(--border)',
          marginRight: 8
        }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ 
              fontFamily: 'var(--font-mono)', 
              fontSize: 10, 
              color: 'var(--text-3)',
              textAlign: 'right',
              lineHeight: 1
            }}>
              {tick}
            </div>
          ))}
        </div>
        
        {/* Bars container */}
        <div style={{ flex: 1 }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'flex-end', 
            gap: 6, 
            height: barAreaHeight, 
            width: '100%',
            borderBottom: '1px solid var(--border)'
          }}>
            {data.map((d, i) => (
              <div key={i} style={{ 
                flex: 1, 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                gap: 4, 
                height: '100%', 
                justifyContent: 'flex-end', 
                minWidth: 0 
              }}>
                <div style={{ 
                  width: '100%', 
                  borderRadius: '3px 3px 0 0', 
                  height: `${(d.value / max) * (barAreaHeight - 20)}px`, 
                  minHeight: d.value > 0 ? 3 : 0, 
                  background: color, 
                  opacity: d.value > 0 ? 1 : 0.15, 
                  transition: 'height 0.6s cubic-bezier(.4,0,.2,1)',
                  position: 'relative',
                }}>
                  {/* Value label on top of bar */}
                  {showValues && d.value > 0 && (
                    <div style={{
                      position: 'absolute',
                      top: -20,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: color,
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      background: 'rgba(0,0,0,0.7)',
                      padding: '2px 5px',
                      borderRadius: 4,
                      pointerEvents: 'none',
                    }}>
                      {d.value}
                    </div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>{d.label}</span>
              </div>
            ))}
          </div>
          {yAxisLabel && (
            <div style={{ 
              textAlign: 'center', 
              marginTop: 8, 
              fontFamily: 'var(--font-mono)', 
              fontSize: 9, 
              color: 'var(--text-3)' 
            }}>
              {yAxisLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Enhanced DualBarChart with Y-axis and values ─────────────────────────
function DualBarChart({ data, showValues = true }) {
  if (!data || data.length === 0) return (
    <div style={{ height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>No data yet</div>
  )
  
  const max = Math.max(...data.map(d => Math.max(d.high, d.low)), 1)
  const barAreaHeight = 100
  const yAxisWidth = 40
  
  // Calculate Y-axis ticks
  const yTicks = [0, Math.round(max * 0.25), Math.round(max * 0.5), Math.round(max * 0.75), max]
  
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {/* Y-axis labels */}
        <div style={{ 
          width: yAxisWidth, 
          display: 'flex', 
          flexDirection: 'column', 
          justifyContent: 'space-between',
          height: barAreaHeight,
          paddingRight: 8,
          borderRight: '1px solid var(--border)',
          marginRight: 8
        }}>
          {yTicks.slice().reverse().map((tick, i) => (
            <div key={i} style={{ 
              fontFamily: 'var(--font-mono)', 
              fontSize: 10, 
              color: 'var(--text-3)',
              textAlign: 'right',
              lineHeight: 1
            }}>
              {tick}
            </div>
          ))}
        </div>
        
        {/* Bars container */}
        <div style={{ flex: 1 }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'flex-end', 
            gap: 6, 
            height: barAreaHeight, 
            width: '100%',
            borderBottom: '1px solid var(--border)'
          }}>
            {data.map((d, i) => {
              const maxBarHeight = Math.max(d.high, d.low)
              const barHeightPercent = (maxBarHeight / max) * (barAreaHeight - 20)
              
              return (
                <div key={i} style={{ 
                  flex: 1, 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  gap: 4, 
                  height: '100%', 
                  justifyContent: 'flex-end', 
                  minWidth: 0 
                }}>
                  <div style={{ 
                    width: '100%', 
                    display: 'flex', 
                    gap: 3, 
                    alignItems: 'flex-end', 
                    justifyContent: 'center',
                    height: barHeightPercent,
                    minHeight: (d.high > 0 || d.low > 0) ? 3 : 0,
                  }}>
                    {/* High bar (red) */}
                    <div style={{ 
                      flex: 1, 
                      borderRadius: '2px 2px 0 0', 
                      height: maxBarHeight > 0 ? `${(d.high / maxBarHeight) * 100}%` : '0%',
                      minHeight: d.high > 0 ? 3 : 0,
                      background: '#ff4560', 
                      opacity: d.high > 0 ? 1 : 0.12,
                      position: 'relative',
                      transition: 'height 0.6s cubic-bezier(.4,0,.2,1)'
                    }}>
                      {showValues && d.high > 0 && (
                        <div style={{
                          position: 'absolute',
                          top: -20,
                          left: '50%',
                          transform: 'translateX(-50%)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8,
                          color: '#ff4560',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          background: 'rgba(0,0,0,0.7)',
                          padding: '2px 4px',
                          borderRadius: 4,
                          pointerEvents: 'none',
                        }}>
                          {d.high}
                        </div>
                      )}
                    </div>
                    
                    {/* Low bar (orange) */}
                    <div style={{ 
                      flex: 1, 
                      borderRadius: '2px 2px 0 0', 
                      height: maxBarHeight > 0 ? `${(d.low / maxBarHeight) * 100}%` : '0%',
                      minHeight: d.low > 0 ? 3 : 0,
                      background: '#ffb020', 
                      opacity: d.low > 0 ? 1 : 0.12,
                      position: 'relative',
                      transition: 'height 0.6s cubic-bezier(.4,0,.2,1)'
                    }}>
                      {showValues && d.low > 0 && (
                        <div style={{
                          position: 'absolute',
                          top: -20,
                          left: '50%',
                          transform: 'translateX(-50%)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 8,
                          color: '#ffb020',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          background: 'rgba(0,0,0,0.7)',
                          padding: '2px 4px',
                          borderRadius: 4,
                          pointerEvents: 'none',
                        }}>
                          {d.low}
                        </div>
                      )}
                    </div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)' }}>{d.label}</span>
                </div>
              )
            })}
          </div>
          
          {/* Legend */}
          <div style={{ display: 'flex', gap: 16, marginTop: 12, justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 12, background: '#ff4560', borderRadius: 2 }}></span>
              High Leaks
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 12, background: '#ffb020', borderRadius: 2 }}></span>
              Low Leaks
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
function Sparkline({ data, color, height = 40 }) {
  if (!data || data.length < 2) return null
  const w = 200, h = height, pad = 4
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1
  const pts = data.map((v, i) => [pad + (i / (data.length - 1)) * (w - pad * 2), h - pad - ((v - min) / range) * (h - pad * 2)])
  const line = pts.map(p => p.join(',')).join(' ')
  const area = `M${pad},${h} L${pts.map(p => p.join(',')).join(' L')} L${w - pad},${h} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg-${color.replace('#', '')})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

// ─── Cylinder Selector ─────────────────────────────────────────────────────────
function CylinderSelector({ selectedId, onChange }) {
  return (
    <div>
      <SectionTitle>⚖️ Gas Cylinder Size</SectionTitle>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-2)', marginBottom: 14, lineHeight: 1.6 }}>
        Select your LPG cylinder size. The app uses this to calculate gas level (%) from the load cell weight.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {CYLINDER_PRESETS.map(p => {
          const active = p.id === selectedId
          return (
            <button key={p.id} onClick={() => onChange(p.id)} style={{
              padding: '14px 8px', borderRadius: 'var(--r-sm)',
              border: active ? '1.5px solid #4d8eff' : '1px solid var(--border)',
              background: active ? 'rgba(77,142,255,0.12)' : 'var(--surface2)',
              color: active ? '#4d8eff' : 'var(--text-2)',
              fontFamily: 'var(--font-disp)', fontSize: 18, fontWeight: 800,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              transition: 'all 0.2s',
            }}>
              {p.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: active ? 'rgba(77,142,255,0.8)' : 'var(--text-3)', fontWeight: 400 }}>{(p.net_g / 1000).toFixed(0)}kg gas</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', fontWeight: 400 }}>tare {(p.tare_g / 1000).toFixed(0)}kg</span>
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 12, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface2)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', lineHeight: 1.7 }}>
        Formula: <span style={{ color: 'var(--text-2)' }}>(weight_grams − tare) ÷ net_gas × 100</span> · Clamped 0–100%
      </div>
    </div>
  )
}

// ─── Cooking Mode Toggle ───────────────────────────────────────────────────────
function CookingModeToggle({ active, onToggle }) {
  return (
    <button onClick={onToggle} title={active ? 'Cooking Mode ON — tap to disable' : 'Pause MQ6 alerts while cooking'} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20,
      border: active ? '1px solid rgba(255,176,32,0.5)' : '1px solid var(--border)',
      background: active ? 'rgba(255,176,32,0.12)' : 'var(--surface2)',
      color: active ? '#ffb020' : 'var(--text-3)',
      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500,
      transition: 'all 0.25s', letterSpacing: '0.04em', whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 13 }}>🍳</span>
      {active ? 'COOKING ON' : 'COOKING'}
    </button>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab]                            = useState('dashboard')
  const [rawWeightG, setRawWeightG]              = useState(null)
  const [levelHistory, setLevelHistory]          = useState([])
  const [connected, setConnected]                = useState(false)
  const [lastSeen, setLastSeen]                  = useState(new Date())
  const [loaded, setLoaded]                      = useState(false)
  const [demoMode]                               = useState(!isConfigured())
  const [cylinderId, setCylinderIdRaw]           = useState(() => localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER)
  const cylinderPreset                           = CYLINDER_PRESETS.find(p => p.id === cylinderId) || CYLINDER_PRESETS[1]

  // customTare_g: weight of your EMPTY cylinder (set via calibration in Device tab)
  // When null, the app auto-detects whether ESP32 sends total or net-only weight
  const [customTare_g, setCustomTare_g]          = useState(() => {
    const v = localStorage.getItem('gaswatch_custom_tare')
    return v != null ? parseFloat(v) : null
  })
  const setCustomTare = (val) => {
    setCustomTare_g(val)
    if (val == null) localStorage.removeItem('gaswatch_custom_tare')
    else localStorage.setItem('gaswatch_custom_tare', String(val))
  }
  const customTareRef = useRef(customTare_g)
  useEffect(() => { customTareRef.current = customTare_g }, [customTare_g])

  // gasLevel is DERIVED every render
  const gasLevel = rawWeightG != null ? weightToPercent(rawWeightG, cylinderPreset, customTare_g) : 0

  const cylinderPresetRef = useRef(cylinderPreset)
  useEffect(() => { cylinderPresetRef.current = cylinderPreset }, [cylinderPreset])

  const setCylinderId = id => {
    setCylinderIdRaw(id)
    localStorage.setItem('gaswatch_cylinder', id)
  }

  // History update — fires whenever weight, preset, or tare changes
  useEffect(() => {
    if (rawWeightG == null) return
    const pct = weightToPercent(rawWeightG, cylinderPreset, customTare_g)
    setLevelHistory(prev => [...prev.slice(-59), pct])
  }, [rawWeightG, cylinderPreset, customTare_g])

  const [severity, setSeverity]                  = useState('safe')
  const [currentPpm, setCurrentPpm]              = useState(null)
  const [currentRaw, setCurrentRaw]              = useState(null)
  const [ppmHistory, setPpmHistory]              = useState([])
  const [alarmBanner, setAlarmBanner]            = useState(false)
  const [alerts, setAlerts]                      = useState([])
  const [totalLeaks, setTotalLeaks]              = useState(0)
  const [cookingMode, setCookingModeRaw]         = useState(() => localStorage.getItem('gaswatch_cooking') === 'true')
  const [cookingStart, setCookingStart]          = useState(null)
  const cookingRef                               = useRef(cookingMode)
  const setCookingMode = val => {
    setCookingModeRaw(val); cookingRef.current = val
    localStorage.setItem('gaswatch_cooking', val ? 'true' : 'false')
    if (val) setCookingStart(Date.now())
    else { setCookingStart(null); setAlarmBanner(false); clearInterval(alarmTimer.current) }
  }
  const [weeklyUsage, setWeeklyUsage]            = useState([])
  const [weeklyLeaksBySev, setWeeklyLeaksBySev]  = useState([])
  const [weeklyPpm, setWeeklyPpm]                = useState([])
  const [avgPpm7d, setAvgPpm7d]                  = useState(null)
  const [maxPpm7d, setMaxPpm7d]                  = useState(null)
  const [highLeaks7d, setHighLeaks7d]            = useState(0)
  const [lowLeaks7d, setLowLeaks7d]              = useState(0)

  const audioCtx   = useRef(null)
  const alarmTimer = useRef(null)

  // Auto-off cooking mode after 2 hours
  useEffect(() => {
    if (!cookingMode || !cookingStart) return
    const ms = 2 * 60 * 60 * 1000 - (Date.now() - cookingStart)
    if (ms <= 0) { setCookingMode(false); return }
    const t = setTimeout(() => setCookingMode(false), ms)
    return () => clearTimeout(t)
  }, [cookingMode, cookingStart])

  const playAlarm = useCallback(() => {
    try {
      if (!audioCtx.current) audioCtx.current = new AudioContext()
      const ctx = audioCtx.current
      [[880, 0], [660, 0.2], [880, 0.4], [660, 0.6]].forEach(([freq, t]) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type = 'sawtooth'; osc.frequency.value = freq
        gain.gain.setValueAtTime(0.18, ctx.currentTime + t)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18)
        osc.start(ctx.currentTime + t); osc.stop(ctx.currentTime + t + 0.2)
      })
    } catch (_) {}
  }, [])

  const handleLeakEvent = useCallback((sev, id, ts, rawPpm, raw) => {
    const fPpm = filterPpm(rawPpm)
    const fSev = filterSeverity(sev, rawPpm)
    setSeverity(fSev); setLastSeen(new Date(ts || Date.now()))
    setCurrentPpm(fPpm)
    if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])
    if (raw != null) setCurrentRaw(raw)
    if (cookingRef.current) { setAlarmBanner(false); clearInterval(alarmTimer.current); return }
    if (fSev !== 'safe') {
      const a = { id: id || Date.now(), severity: fSev, time: fmtTime(ts || Date.now()), date: fmtDate(ts || Date.now()), msg: fSev === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected', ppm: fPpm, raw }
      setAlerts(prev => [a, ...prev.slice(0, 99)])
      if (fSev === 'high') {
        setTotalLeaks(t => t + 1); setAlarmBanner(true); playAlarm()
        clearInterval(alarmTimer.current); alarmTimer.current = setInterval(playAlarm, 2500)
      }
    } else { setAlarmBanner(false); clearInterval(alarmTimer.current) }
  }, [playAlarm])

  useEffect(() => {
    if (demoMode) {
      setTimeout(() => setLoaded(true), 300)
      const DL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      setWeeklyLeaksBySev(DL.map((l, i) => ({ label: l, high: [0,1,0,0,1,0,1][i], low: [0,1,1,0,2,0,0][i] })))
      setWeeklyPpm(DL.map((l, i) => ({ label: l, value: [0,350,0,0,420,0,0][i] })))
      setRawWeightG(11400)
      setWeeklyUsage(DL.map((l, i) => ({ label: l, value: [68,65,63,61,58,55,57][i] })))
      setLevelHistory([68,65,63,61,58,55,57])
      setCurrentPpm(null); setCurrentRaw(218)
      setAvgPpm7d(null); setMaxPpm7d(750)
      setHighLeaks7d(2); setLowLeaks7d(5)
      setPpmHistory([0,0,0,0,350,0,0,750,0,0,0,0])
      setAlerts([
        { id: 1, severity: 'high', time: '10:24:15', date: 'Jun 3', msg: 'CRITICAL gas leakage detected!', ppm: 750 },
        { id: 2, severity: 'low',  time: '08:12:03', date: 'Jun 3', msg: 'Minor gas leakage detected',    ppm: 350 },
        { id: 3, severity: 'low',  time: '22:05:41', date: 'Jun 2', msg: 'Minor gas leakage detected',    ppm: 320 },
      ])
      setTotalLeaks(7); setConnected(false)
      const iv = setInterval(() => {
        setRawWeightG(prev => {
          const nw = genDemoWeight(prev)
          const pr = CYLINDER_PRESETS.find(p => p.id === (localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER)) || CYLINDER_PRESETS[1]
          // FIX: Update history directly here to avoid async issues
          setLevelHistory(h => [...h.slice(-59), weightToPercent(nw, pr)])
          return nw
        })
        const i = demoIdx++ % demoSevs.length
        const fPpm = filterPpm(demoPpm[i]); const fSev = filterSeverity(demoSevs[i], demoPpm[i])
        setSeverity(fSev); setCurrentPpm(fPpm)
        if (fPpm != null) setPpmHistory(h => [...h.slice(-59), fPpm])
        setLastSeen(new Date())
        if (!cookingRef.current && fSev !== 'safe') {
          const a = { id: Date.now(), severity: fSev, ppm: fPpm, time: fmtTime(Date.now()), date: fmtDate(Date.now()), msg: fSev === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected' }
          setAlerts(p => [a, ...p.slice(0, 99)])
          if (fSev === 'high') { setTotalLeaks(t => t + 1); setAlarmBanner(true); playAlarm(); clearInterval(alarmTimer.current); alarmTimer.current = setInterval(playAlarm, 2500) }
        } else if (fSev === 'safe') { setAlarmBanner(false); clearInterval(alarmTimer.current) }
      }, 3500)
      return () => { clearInterval(iv); clearInterval(alarmTimer.current) }
    }

    let levelCh, leakCh
    async function init() {
      // Load initial gas level history
      const { data: lvls } = await supabase
        .from('gas_levels')
        .select('weight_grams,created_at')
        .order('created_at', { ascending: false })
        .limit(60)

      if (lvls?.length > 0) {
        const pr = CYLINDER_PRESETS.find(p => p.id === (localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER)) || CYLINDER_PRESETS[1]
        const ct = customTareRef.current
        const latestWeight = Number(lvls[0].weight_grams)
        
        // Set all together
        setRawWeightG(latestWeight)
        setLastSeen(new Date(lvls[0].created_at))
        setConnected(true)
        setLevelHistory(lvls.map(r => weightToPercent(Number(r.weight_grams), pr, ct)).reverse())
      }

      // Load initial leakage data
      const { data: leaks } = await supabase
        .from('gas_leakages')
        .select('id,severity,raw_value,ppm_approx,created_at')
        .order('created_at', { ascending: false })
        .limit(100)

      if (leaks?.length > 0) {
        const l = leaks[0]
        setSeverity(filterSeverity(l.severity, l.ppm_approx))
        setCurrentPpm(filterPpm(l.ppm_approx))
        if (l.raw_value != null) setCurrentRaw(l.raw_value)
        setPpmHistory(leaks.slice(0, 60).map(r => filterPpm(r.ppm_approx) ?? 0).reverse())
        const filtered = leaks.filter(r => filterSeverity(r.severity, r.ppm_approx) !== 'safe')
        setAlerts(filtered.map(r => ({
          id: r.id,
          severity: filterSeverity(r.severity, r.ppm_approx),
          time: fmtTime(r.created_at),
          date: fmtDate(r.created_at),
          msg: r.severity === 'high' ? 'CRITICAL gas leakage detected!' : 'Minor gas leakage detected',
          ppm: filterPpm(r.ppm_approx),
          raw: r.raw_value
        })))
        setTotalLeaks(filtered.length)
        setConnected(true)
      }

      // Weekly analytics (unchanged)
      const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      const { data: wLvls } = await supabase
        .from('gas_levels')
        .select('weight_grams,created_at')
        .gte('created_at', sevenAgo)

      if (wLvls?.length > 0) {
        const pr = CYLINDER_PRESETS.find(p => p.id === (localStorage.getItem('gaswatch_cylinder') || DEFAULT_CYLINDER)) || CYLINDER_PRESETS[1]
        const ct = customTareRef.current
        const sums = {}, cnts = {}
        DAYS.forEach(d => { sums[d] = 0; cnts[d] = 0 })
        wLvls.forEach(r => {
          const d = DAYS[new Date(r.created_at).getDay()]
          sums[d] += weightToPercent(Number(r.weight_grams), pr, ct)
          cnts[d]++
        })
        setWeeklyUsage(DAYS.map(d => ({ label: d.slice(0, 3), value: cnts[d] > 0 ? Math.round(sums[d] / cnts[d]) : 0 })))
      } else {
        setWeeklyUsage(DAYS.map(d => ({ label: d.slice(0, 3), value: 0 })))
      }

      const { data: wLeaks } = await supabase
        .from('gas_leakages')
        .select('severity,ppm_approx,created_at')
        .gte('created_at', sevenAgo)

      if (wLeaks?.length > 0) {
        const bySev = {}, ppmS = {}, ppmC = {}
        DAYS.forEach(d => { bySev[d] = { high: 0, low: 0 }; ppmS[d] = 0; ppmC[d] = 0 })
        let sumP = 0, cntP = 0, maxP = 0, cH = 0, cL = 0
        wLeaks.forEach(r => {
          const d    = DAYS[new Date(r.created_at).getDay()]
          const fSev = filterSeverity(r.severity, r.ppm_approx)
          const fPpm = filterPpm(r.ppm_approx)
          if (fSev === 'high') { bySev[d].high++; cH++ }
          if (fSev === 'low')  { bySev[d].low++;  cL++ }
          if (fPpm != null) { ppmS[d] += fPpm; ppmC[d]++; sumP += fPpm; cntP++; if (fPpm > maxP) maxP = fPpm }
        })
        setWeeklyLeaksBySev(DAYS.map(d => ({ label: d.slice(0, 3), high: bySev[d].high, low: bySev[d].low })))
        setWeeklyPpm(DAYS.map(d => ({ label: d.slice(0, 3), value: ppmC[d] > 0 ? Math.round(ppmS[d] / ppmC[d]) : 0 })))
        setAvgPpm7d(cntP > 0 ? Math.round(sumP / cntP) : null)
        setMaxPpm7d(maxP > 0 ? Math.round(maxP) : null)
        setHighLeaks7d(cH); setLowLeaks7d(cL)
      } else {
        setWeeklyLeaksBySev(DAYS.map(d => ({ label: d.slice(0, 3), high: 0, low: 0 })))
        setWeeklyPpm(DAYS.map(d => ({ label: d.slice(0, 3), value: 0 })))
      }

      setLoaded(true)
    }

    init()

    // Realtime subscription
    if (supabase) {
      levelCh = supabase.channel('rt-levels')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gas_levels' }, p => {
          const w = Number(p.new.weight_grams)
          const pr = cylinderPresetRef.current
          const ct = customTareRef.current
          
          setRawWeightG(w)
          setLastSeen(new Date(p.new.created_at))
          setConnected(true)
          setLevelHistory(prev => [...prev.slice(-59), weightToPercent(w, pr, ct)])
        })
        .subscribe()

      leakCh = supabase.channel('rt-leakages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'gas_leakages' }, p => {
          const { severity: sev, id, created_at, ppm_approx, raw_value } = p.new
          handleLeakEvent(sev, id, created_at, ppm_approx, raw_value)
          setConnected(true)
        })
        .subscribe()
    }

    return () => {
      if (supabase) {
        if (levelCh) supabase.removeChannel(levelCh)
        if (leakCh) supabase.removeChannel(leakCh)
      }
      clearInterval(alarmTimer.current)
    }
  }, [demoMode, handleLeakEvent, playAlarm])

  // ── Derived state ────────────────────────────────────────────────────────
  const displaySev    = cookingMode ? 'safe' : severity
  const displayPpm    = cookingMode ? null : currentPpm
  const sCol          = cookingMode ? C.safe : C[severity]
  const lCol          = levelColor(gasLevel)
  const rules         = getRecommendations(displaySev, gasLevel, displayPpm)
  const estDays       = gasLevel > 0 ? Math.max(0, Math.ceil(gasLevel / 2.1)) : 0
  const nonSafeAlerts = alerts.filter(a => a.severity !== 'safe')

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: '◈' },
    { id: 'alerts',    label: 'Alerts',    icon: '◉', badge: nonSafeAlerts.length },
    { id: 'analytics', label: 'Analytics', icon: '◎' },
    { id: 'device',    label: 'Device',    icon: '◇' },
  ]

  if (!loaded) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
      <div style={{ width: 36, height: 36, border: '2px solid var(--border2)', borderTopColor: '#00e5a0', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.12em' }}>INITIALISING</span>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', width: '100%', maxWidth: '100%', overflowX: 'hidden' }}>

      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 200,
        background: 'rgba(10,14,26,0.92)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 16px', height: 56,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: 'linear-gradient(135deg,#ff6b35,#ff4560)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, boxShadow: '0 0 14px rgba(255,69,96,0.35)' }}>🔥</div>
          <div>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 16, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em' }}>
              GasWatch <span style={{ color: '#4d8eff' }}>Pro</span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-3)', letterSpacing: '0.12em' }}>
              {demoMode ? 'DEMO MODE' : 'LIVE · IOT MONITORING'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <CookingModeToggle active={cookingMode} onToggle={() => setCookingMode(!cookingMode)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 20, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            <StatusDot online={connected} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: connected ? '#00e5a0' : '#ff4560' }}>
              {connected ? 'LIVE' : demoMode ? 'DEMO' : 'OFFLINE'}
            </span>
          </div>
          <Chip label={displaySev.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </div>
      </header>

      {/* ── COOKING MODE BANNER ─────────────────────────────────── */}
      {cookingMode && (
        <div className="slide-down" style={{
          position: 'sticky', top: 56, zIndex: 190,
          background: 'rgba(255,176,32,0.10)', borderBottom: '1px solid rgba(255,176,32,0.25)',
          padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>🍳</span>
            <div>
              <div style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, color: '#ffb020', fontSize: 12 }}>Cooking Mode — MQ6 paused</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,176,32,0.7)', marginTop: 1 }}>Auto-off after 2 hours</div>
            </div>
          </div>
          <button onClick={() => setCookingMode(false)} style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'rgba(255,176,32,0.2)', border: '1px solid rgba(255,176,32,0.4)', color: '#ffb020' }}>Off</button>
        </div>
      )}

      {/* ── ALARM BANNER ────────────────────────────────────────── */}
      {alarmBanner && !cookingMode && (
        <div className="slide-down" style={{
          position: 'sticky', top: cookingMode ? 112 : 56, zIndex: 190,
          background: 'rgba(255,69,96,0.12)', borderBottom: '1px solid rgba(255,69,96,0.3)',
          padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          animation: 'shimmer 0.8s ease infinite',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20, flexShrink: 0 }}>🚨</span>
            <div>
              <div style={{ fontFamily: 'var(--font-disp)', fontWeight: 700, color: '#ff4560', fontSize: 13 }}>
                CRITICAL LEAK{currentPpm ? ` · ~${Math.round(currentPpm)} ppm` : ''}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,69,96,0.8)', marginTop: 1 }}>
                Evacuate · Cut power · Call emergency
              </div>
            </div>
          </div>
          <button onClick={() => { setAlarmBanner(false); clearInterval(alarmTimer.current) }} style={{ padding: '5px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: '#ff4560', color: '#fff', boxShadow: '0 0 14px rgba(255,69,96,0.4)', flexShrink: 0 }}>
            Dismiss
          </button>
        </div>
      )}

      {/* ─── DESKTOP TAB NAV ─────────────────────────────────────── */}
      <nav id="desktop-nav" style={{
        background: 'rgba(10,14,26,0.8)', backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 12px', overflowX: 'auto', gap: 0,
        WebkitOverflowScrolling: 'touch',
      }}>
        {navItems.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            padding: '14px 18px', fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-body)',
            color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
            borderBottom: `2px solid ${tab === n.id ? '#4d8eff' : 'transparent'}`,
            borderRadius: 0, whiteSpace: 'nowrap', transition: 'color 0.2s',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{n.icon}</span>{n.label}
            {n.badge > 0 && (
              <span style={{ background: '#ff4560', color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 10, padding: '1px 5px', fontFamily: 'var(--font-mono)' }}>
                {n.badge > 99 ? '99+' : n.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* ── MAIN CONTENT ────────────────────────────────────────── */}
      <main id="main-content" className="fade-up" style={{ flex: 1, padding: '16px', maxWidth: 960, width: '100%', margin: '0 auto', minWidth: 0, overflowX: 'hidden' }}>

        {tab === 'dashboard' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <DashboardTab
              gasLevel={gasLevel} lCol={lCol} rawWeightG={rawWeightG} cylinderPreset={cylinderPreset}
              levelHistory={levelHistory} severity={severity} displaySev={displaySev}
              displayPpm={displayPpm} currentPpm={currentPpm} sCol={sCol} ppmHistory={ppmHistory}
              cookingMode={cookingMode} estDays={estDays} totalLeaks={totalLeaks} rules={rules}
            />
          </div>
        )}

        {tab === 'alerts' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <AlertsTab nonSafeAlerts={nonSafeAlerts} setAlerts={setAlerts} />
          </div>
        )}

        {tab === 'analytics' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <AnalyticsTab
              estDays={estDays} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d}
              highLeaks7d={highLeaks7d} lowLeaks7d={lowLeaks7d}
              weeklyUsage={weeklyUsage} weeklyLeaksBySev={weeklyLeaksBySev} weeklyPpm={weeklyPpm}
              gasLevel={gasLevel} cylinderPreset={cylinderPreset} levelHistory={levelHistory}
              rawWeightG={rawWeightG}
            />
          </div>
        )}

        {tab === 'device' && (
          <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
            <DeviceTab
              cylinderId={cylinderId} setCylinderId={setCylinderId}
              connected={connected} demoMode={demoMode} lastSeen={lastSeen}
              displaySev={displaySev} displayPpm={displayPpm} currentRaw={currentRaw}
              cookingMode={cookingMode} avgPpm7d={avgPpm7d} maxPpm7d={maxPpm7d} sCol={sCol}
              rawWeightG={rawWeightG} cylinderPreset={cylinderPreset}
              customTare_g={customTare_g} setCustomTare={setCustomTare}
              gasLevel={gasLevel}
            />
          </div>
        )}
      </main>

      {/* ── MOBILE BOTTOM NAV ───────────────────────────────────── */}
      <nav id="mobile-nav" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
        background: 'rgba(10,14,26,0.97)', backdropFilter: 'blur(16px)',
        borderTop: '1px solid var(--border)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        <div style={{ display: 'flex', height: 60 }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              gap: 3, padding: '8px 4px', position: 'relative',
              color: tab === n.id ? '#f0f4ff' : 'var(--text-3)',
              transition: 'color 0.2s',
            }}>
              {tab === n.id && (
                <div style={{ position: 'absolute', top: 6, width: 4, height: 4, borderRadius: '50%', background: '#4d8eff' }} />
              )}
              <span style={{ fontSize: 18, lineHeight: 1 }}>{n.icon}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.05em' }}>{n.label}</span>
              {n.badge > 0 && (
                <span style={{ position: 'absolute', top: 8, right: '14%', background: '#ff4560', color: '#fff', fontSize: 8, fontWeight: 700, borderRadius: 8, padding: '0 4px', fontFamily: 'var(--font-mono)' }}>
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
function DashboardTab({ gasLevel, lCol, rawWeightG, cylinderPreset, levelHistory, severity, displaySev, displayPpm, currentPpm, sCol, ppmHistory, cookingMode, estDays, totalLeaks, rules }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: '100%' }}>
        <Card accent={lCol.main} glow={lCol.glow} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 12px', minWidth: 0 }}>
          <SectionTitle style={{ marginBottom: 10 }}>Cylinder Level</SectionTitle>
          <ArcGauge value={gasLevel} color={lCol.main} size={130} />
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <Chip
              label={gasLevel < 20 ? '⚠ Replace Now' : gasLevel < 40 ? '⚠ Plan Refill' : '✓ Sufficient'}
              color={lCol.main} border={lCol.border} bg={lCol.dim}
            />
            {rawWeightG != null && (
              <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', letterSpacing: '0.06em' }}>
                {(rawWeightG / 1000).toFixed(2)} kg · {cylinderPreset.label}
              </div>
            )}
          </div>
        </Card>

        <Card accent={sCol.main} glow={displaySev !== 'safe' ? sCol.glow : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '20px 12px', minWidth: 0 }}>
          <SectionTitle style={{ marginBottom: 6 }}>Leak Status</SectionTitle>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: sCol.dim, border: `1.5px solid ${sCol.border}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30,
            boxShadow: displaySev !== 'safe' ? sCol.glow : undefined,
            animation: displaySev === 'high' ? 'pulseRed 1.2s ease infinite' : displaySev === 'safe' ? 'pulseGreen 3s ease infinite' : undefined,
          }}>
            {cookingMode ? '🍳' : displaySev === 'high' ? '🚨' : displaySev === 'low' ? '⚠️' : '✅'}
          </div>
          <div style={{ fontFamily: 'var(--font-disp)', fontSize: 16, fontWeight: 800, color: sCol.main, textAlign: 'center' }}>
            {cookingMode ? 'PAUSED' : displaySev === 'high' ? 'CRITICAL' : displaySev === 'low' ? 'LOW LEAK' : 'ALL SAFE'}
          </div>
          <Chip label={cookingMode ? 'COOKING' : displaySev.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </Card>
      </div>

      <Card>
        <SectionTitle>MQ6 Gas Concentration</SectionTitle>
        <PpmBar ppm={displayPpm} />
        {ppmHistory.filter(v => v > 0).length > 2 && !cookingMode && (
          <div style={{ marginTop: 10 }}>
            <Sparkline data={ppmHistory} color={sCol.main} height={32} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 3, textAlign: 'center', letterSpacing: '0.07em' }}>PPM TREND (≥300 only)</div>
          </div>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%' }}>
        {[
          { label: 'Days Left',   val: `~${estDays}d`,            col: '#4d8eff' },
          { label: 'Gas Level',   val: `${Math.round(gasLevel)}%`, col: lCol.main },
          { label: 'Leak Events', val: totalLeaks,                 col: '#ff4560' },
        ].map((s, i) => (
          <Card key={i} style={{ textAlign: 'center', padding: '14px 8px', minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 24, fontWeight: 800, color: s.col, lineHeight: 1 }}>{s.val}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 6, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>

      {levelHistory.length > 2 && (
        <Card>
          <SectionTitle>Level Trend · Last {Math.min(levelHistory.length, 60)} Readings</SectionTitle>
          <Sparkline data={levelHistory} color={lCol.main} height={48} />
        </Card>
      )}

      <Card accent={sCol.main}>
        <SectionTitle>⚡ Safety Recommendations</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((r, i) => (
            <div key={i} style={{
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              background: r.urgent ? sCol.dim : 'var(--surface2)',
              border: `1px solid ${r.urgent ? sCol.border : 'var(--border)'}`,
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
              <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>{r.icon}</span>
              <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: 1.5, color: r.urgent ? sCol.main : 'var(--text-2)', fontWeight: r.urgent ? 600 : 400 }}>
                {r.text}
              </span>
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
function AlertsTab({ nonSafeAlerts, setAlerts }) {
  return (
    <Card style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <SectionTitle style={{ marginBottom: 4 }}>Alert History · MQ6</SectionTitle>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
            {nonSafeAlerts.length} leak event{nonSafeAlerts.length !== 1 ? 's' : ''} · ≥300 ppm only
          </div>
        </div>
        <button onClick={() => setAlerts([])} style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text-2)', flexShrink: 0 }}>
          Clear All
        </button>
      </div>
      {nonSafeAlerts.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-3)' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🛡️</div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 14, marginBottom: 4 }}>No leakage events recorded</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>All MQ6 readings below 300 ppm</div>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        {nonSafeAlerts.map(a => {
          const ac = C[a.severity]
          return (
            <div key={a.id} style={{ padding: '12px 14px', borderRadius: 'var(--r-sm)', background: ac.dim, border: `1px solid ${ac.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 18, flexShrink: 0 }}>{a.severity === 'high' ? '🚨' : '⚠️'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: ac.main }}>{a.msg}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>{a.date} · {a.time}</span>
                    {a.ppm != null && <span style={{ color: ac.main }}>~{Math.round(a.ppm)} ppm</span>}
                  </div>
                </div>
              </div>
              <Chip label={a.severity.toUpperCase()} color={ac.main} border={ac.border} bg={ac.dim} style={{ flexShrink: 0 }} />
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// ANALYTICS TAB
// ══════════════════════════════════════════════════════════════════════════
function AnalyticsTab({ estDays, avgPpm7d, maxPpm7d, highLeaks7d, lowLeaks7d, weeklyUsage, weeklyLeaksBySev, weeklyPpm, gasLevel, cylinderPreset, levelHistory, rawWeightG }) {
  const lCol = levelColor(gasLevel)
  const statRows = [
    { label: 'Days Remaining', val: `~${estDays}d`,                                  col: '#00e5a0' },
    { label: 'Avg Daily Use',  val: '~2.1%',                                          col: '#4d8eff' },
    { label: 'Avg PPM (7d)',   val: avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm',  col: '#ffb020' },
    { label: 'Peak PPM (7d)',  val: maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm',  col: '#ff4560' },
    { label: 'High Leaks 7d', val: highLeaks7d,                                       col: '#ff4560' },
    { label: 'Low Leaks 7d',  val: lowLeaks7d,                                        col: '#ffb020' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, width: '100%' }}>
        {statRows.map((s, i) => (
          <Card key={i} style={{ textAlign: 'center', padding: '16px 10px', minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 26, fontWeight: 800, color: s.col, lineHeight: 1 }}>{s.val}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 8, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </Card>
        ))}
      </div>
      <Card>
        <SectionTitle>Weekly Gas Usage (avg %)</SectionTitle>
        <BarChart data={weeklyUsage} color="#4d8eff" showValues={true} />
        <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
          {cylinderPreset.label} cylinder · ~{estDays} days remaining
        </div>
      </Card>
      <Card>
        <SectionTitle>Weekly Leak Events · MQ6</SectionTitle>
        <DualBarChart data={weeklyLeaksBySev} showValues={true} />
      </Card>
      <Card>
        <SectionTitle>Weekly Average PPM (≥300 ppm only)</SectionTitle>
        <BarChart data={weeklyPpm} color="#ffb020" showValues={true} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', flexWrap: 'wrap', gap: 8 }}>
          <span>7d avg: {avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm'}</span>
          <span style={{ color: maxPpm7d > 500 ? '#ff4560' : maxPpm7d > 300 ? '#ffb020' : 'var(--text-3)' }}>
            peak: {maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm'}
          </span>
        </div>
      </Card>
      {levelHistory.length > 2 && (
        <Card>
          <SectionTitle>Gas Level Trend · Last {Math.min(levelHistory.length, 60)} Readings</SectionTitle>
          <div style={{ height: 80 }}><Sparkline data={levelHistory} color={lCol.main} height={80} /></div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', flexWrap: 'wrap', gap: 8 }}>
            <span>oldest</span>
            <span>now: {Math.round(gasLevel)}%{rawWeightG != null ? ` (${(rawWeightG / 1000).toFixed(2)} kg)` : ''}</span>
          </div>
        </Card>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// DEVICE TAB
// ══════════════════════════════════════════════════════════════════════════
function DeviceTab({ cylinderId, setCylinderId, connected, demoMode, lastSeen, displaySev, displayPpm,
  currentRaw, cookingMode, avgPpm7d, maxPpm7d, sCol,
  rawWeightG, cylinderPreset, customTare_g, setCustomTare, gasLevel }) {

  const [tareInput, setTareInput] = useState(
    customTare_g != null ? String(customTare_g / 1000) : ''
  )
  const [tareMsg, setTareMsg] = useState(null) // { text, ok }

  // What mode is the app currently using?
  const usingCustomTare = customTare_g != null
  const usingAutoNet    = !usingCustomTare && rawWeightG != null && rawWeightG <= cylinderPreset.net_g * 1.05
  const usingPresetTare = !usingCustomTare && !usingAutoNet

  const modeLabel = usingCustomTare
    ? `Custom tare: ${(customTare_g / 1000).toFixed(2)} kg`
    : usingAutoNet
      ? 'Auto-detected: net gas weight mode'
      : `Preset tare: ${(cylinderPreset.tare_g / 1000).toFixed(0)} kg`
  const modeColor = usingCustomTare ? '#00e5a0' : usingAutoNet ? '#4d8eff' : '#ffb020'

  const handleSaveTare = () => {
    const kg = parseFloat(tareInput)
    if (isNaN(kg) || kg < 1 || kg > 30) {
      setTareMsg({ text: 'Enter a valid tare weight between 1–30 kg', ok: false })
      return
    }
    setCustomTare(kg * 1000)
    setTareMsg({ text: `✓ Tare set to ${kg.toFixed(2)} kg — gauge will update now`, ok: true })
    setTimeout(() => setTareMsg(null), 4000)
  }

  const handleClearTare = () => {
    setCustomTare(null)
    setTareInput('')
    setTareMsg({ text: 'Custom tare cleared — using auto-detection', ok: true })
    setTimeout(() => setTareMsg(null), 3000)
  }

  // "Set tare from live reading" — stamp current weight as the empty-cylinder weight
  const handleStampTare = () => {
    if (rawWeightG == null) return
    const kg = rawWeightG / 1000
    setTareInput(kg.toFixed(2))
    setCustomTare(rawWeightG)
    setTareMsg({ text: `✓ Tare stamped at ${kg.toFixed(2)} kg (current reading)`, ok: true })
    setTimeout(() => setTareMsg(null), 4000)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: '100%', overflowX: 'hidden', minWidth: 0 }}>

      {/* ── Cylinder selector ── */}
      <Card style={{ marginBottom: 0, minWidth: 0 }}>
        <CylinderSelector selectedId={cylinderId} onChange={setCylinderId} />
      </Card>

      {/* ── Weight Calibration card ── */}
      <Card accent="#4d8eff" style={{ minWidth: 0 }}>
        <SectionTitle>⚖️ Load Cell Calibration</SectionTitle>

        {/* Current mode banner */}
        <div style={{
          padding: '10px 14px', borderRadius: 'var(--r-sm)', marginBottom: 16,
          background: 'var(--surface2)', border: `1px solid ${modeColor}44`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: modeColor, flexShrink: 0, boxShadow: `0 0 8px ${modeColor}` }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: modeColor, fontWeight: 600, letterSpacing: '0.05em' }}>
              ACTIVE MODE
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-1)', marginTop: 2 }}>
              {modeLabel}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontFamily: 'var(--font-disp)', fontSize: 22, fontWeight: 800, color: '#4d8eff', lineHeight: 1 }}>
              {Math.round(gasLevel)}%
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-3)', marginTop: 2 }}>
              current level
            </div>
          </div>
        </div>

        {/* Live weight readout */}
        {rawWeightG != null && (
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--r-sm)', marginBottom: 16,
            background: 'var(--surface3)', border: '1px solid var(--border)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-3)' }}>
              Live reading from ESP32
            </span>
            <span style={{ fontFamily: 'var(--font-disp)', fontSize: 18, fontWeight: 800, color: 'var(--text-1)' }}>
              {(rawWeightG / 1000).toFixed(3)} kg
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginLeft: 6, fontWeight: 400 }}>
                ({rawWeightG.toFixed(0)} g)
              </span>
            </span>
          </div>
        )}

        {/* Explanation */}
        <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-2)', lineHeight: 1.65, marginBottom: 16 }}>
          If the percentage reads <strong style={{ color: 'var(--text-1)' }}>0% / always red</strong>, your ESP32 is sending the
          weight differently than expected. Use one of the options below to fix it.
        </div>

        {/* Option A: stamp tare from live reading */}
        {rawWeightG != null && (
          <div style={{
            padding: '12px 14px', borderRadius: 'var(--r-sm)', marginBottom: 12,
            background: 'rgba(0,229,160,0.06)', border: '1px solid rgba(0,229,160,0.2)',
          }}>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: '#00e5a0', marginBottom: 4 }}>
              Option A — Empty cylinder on scale right now?
            </div>
            <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 10 }}>
              Place your <strong style={{ color: 'var(--text-2)' }}>empty cylinder</strong> on the scale, wait for a stable reading, then tap below to stamp the current reading as the tare weight.
            </div>
            <button onClick={handleStampTare} style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: 'rgba(0,229,160,0.15)', border: '1px solid rgba(0,229,160,0.4)',
              color: '#00e5a0', letterSpacing: '0.03em',
            }}>
              📍 Stamp {rawWeightG != null ? `${(rawWeightG / 1000).toFixed(3)} kg` : '—'} as Empty Tare
            </button>
          </div>
        )}

        {/* Option B: manual tare entry */}
        <div style={{
          padding: '12px 14px', borderRadius: 'var(--r-sm)', marginBottom: 12,
          background: 'rgba(77,142,255,0.06)', border: '1px solid rgba(77,142,255,0.2)',
        }}>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: '#4d8eff', marginBottom: 4 }}>
            Option B — Enter empty cylinder weight manually
          </div>
          <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 10 }}>
            Check the sticker on your cylinder for the tare weight (marked <strong style={{ color: 'var(--text-2)' }}>T</strong> or <strong style={{ color: 'var(--text-2)' }}>Tare</strong>), then enter it below in kg.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="number" min="1" max="30" step="0.01"
              value={tareInput}
              onChange={e => setTareInput(e.target.value)}
              placeholder={`e.g. ${(cylinderPreset.tare_g / 1000).toFixed(0)}.00`}
              style={{
                flex: 1, minWidth: 100, padding: '8px 12px', borderRadius: 8,
                background: 'var(--surface3)', border: '1px solid var(--border2)',
                color: 'var(--text-1)', fontFamily: 'var(--font-mono)', fontSize: 13,
                outline: 'none',
              }}
            />
            <button onClick={handleSaveTare} style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: 'rgba(77,142,255,0.15)', border: '1px solid rgba(77,142,255,0.4)',
              color: '#4d8eff', whiteSpace: 'nowrap',
            }}>
              Save Tare
            </button>
            {customTare_g != null && (
              <button onClick={handleClearTare} style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                background: 'var(--surface2)', border: '1px solid var(--border)',
                color: 'var(--text-3)', whiteSpace: 'nowrap',
              }}>
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Feedback message */}
        {tareMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--r-sm)',
            background: tareMsg.ok ? 'rgba(0,229,160,0.08)' : 'rgba(255,69,96,0.08)',
            border: `1px solid ${tareMsg.ok ? 'rgba(0,229,160,0.3)' : 'rgba(255,69,96,0.3)'}`,
            fontFamily: 'var(--font-body)', fontSize: 13,
            color: tareMsg.ok ? '#00e5a0' : '#ff4560',
          }}>
            {tareMsg.text}
          </div>
        )}

        {/* Formula display */}
        <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 'var(--r-sm)', background: 'var(--surface3)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', lineHeight: 1.8 }}>
          {usingAutoNet
            ? <>Formula: <span style={{ color: 'var(--text-2)' }}>weight_g ÷ {cylinderPreset.net_g} × 100</span> <span style={{ color: '#4d8eff' }}>(net-only mode)</span></>
            : <>Formula: <span style={{ color: 'var(--text-2)' }}>(weight_g − {usingCustomTare ? customTare_g : cylinderPreset.tare_g}g) ÷ {cylinderPreset.net_g} × 100</span></>
          }
          {' '}· Clamped 0–100%
        </div>
      </Card>

      {/* ── ESP32 Status ── */}
      <Card accent="#4d8eff" style={{ minWidth: 0 }}>
        <SectionTitle>ESP32 Status</SectionTitle>
        {[
          { k: 'Connection', v: connected ? 'Online' : demoMode ? 'Demo Mode' : 'Offline', col: connected ? '#00e5a0' : demoMode ? '#ffb020' : '#ff4560' },
          { k: 'Last Data',  v: lastSeen.toLocaleTimeString(), col: null },
          { k: 'Protocol',   v: 'HTTP POST → Supabase', col: null },
          { k: 'Send Rate',  v: 'Every 5 seconds', col: null },
          { k: 'Firmware',   v: 'GasWatch v2.2.0', col: '#4d8eff' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--text-3)', flexShrink: 0 }}>{r.k}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.col || 'var(--text-2)', textAlign: 'right' }}>{r.v}</span>
          </div>
        ))}
      </Card>

      {/* ── Live MQ6 Readings ── */}
      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Live MQ6 Readings</SectionTitle>
        {[
          { k: 'Severity',   v: cookingMode ? 'PAUSED' : displaySev.toUpperCase(),                   col: cookingMode ? '#ffb020' : sCol.main },
          { k: 'PPM (≥300)', v: displayPpm != null ? `~${Math.round(displayPpm)} ppm` : '0 ppm',     col: displayPpm ? sCol.main : 'var(--text-3)' },
          { k: 'Raw ADC',    v: currentRaw != null ? currentRaw : '—',                               col: 'var(--text-2)' },
          { k: '7d Avg PPM', v: avgPpm7d != null ? `${avgPpm7d} ppm` : '0 ppm',                     col: 'var(--text-2)' },
          { k: '7d Peak',    v: maxPpm7d != null ? `${maxPpm7d} ppm` : '0 ppm',                     col: maxPpm7d > 500 ? '#ff4560' : maxPpm7d > 300 ? '#ffb020' : 'var(--text-2)' },
        ].map((r, i, arr) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', flexShrink: 0 }}>{r.k}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.col }}>{r.v}</span>
          </div>
        ))}
      </Card>

      {/* ── Sensor Health ── */}
      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Sensor Health</SectionTitle>
        {[
          { name: 'HX711 Load Cell', type: 'weight_grams via SPI', health: connected ? 100 : 0, col: '#4d8eff' },
          { name: 'MQ6 Gas Sensor',  type: 'severity + ppm_approx', health: connected ? 98 : 0,  col: '#00e5a0' },
        ].map((s, i) => (
          <div key={i} style={{ padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', marginBottom: i === 0 ? 8 : 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{s.name}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{s.type}</div>
              </div>
              <Chip label={connected ? 'ACTIVE' : 'OFFLINE'} color={connected ? '#00e5a0' : '#ff4560'} style={{ flexShrink: 0 }} />
            </div>
            <div style={{ background: 'var(--surface3)', borderRadius: 4, height: 5, overflow: 'hidden' }}>
              <div style={{ width: `${s.health}%`, height: '100%', background: s.col, borderRadius: 4, transition: 'width 1s ease' }} />
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', textAlign: 'right', marginTop: 4 }}>{s.health}% health</div>
          </div>
        ))}
      </Card>

      {/* ── Integration Notes ── */}
      <Card style={{ minWidth: 0 }}>
        <SectionTitle>Integration Notes</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { icon: '🔗', title: 'ESP32 WiFi',      desc: 'Set WIFI_SSID + WIFI_PASSWORD in firmware.' },
            { icon: '⚖️', title: 'HX711 Load Cell', desc: 'Posts weight_grams every 5 s. Use the calibration card above if the % is stuck at 0.' },
            { icon: '📊', title: 'MQ6 Table',        desc: 'Posts severity, raw_value, ppm_approx. Readings below 300 ppm are suppressed.' },
            { icon: '📡', title: 'Realtime',          desc: 'Enable Realtime on both tables in Supabase → Database → Replication.' },
          ].map((c, i) => (
            <div key={i} style={{ padding: '12px', background: 'var(--surface2)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>{c.icon}</span>
              <div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{c.title}</div>
                <div style={{ fontFamily: 'var(--font-body)', fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{c.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
