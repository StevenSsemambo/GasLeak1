import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase.js'

// ═══════════════════════════════════════════════════════════════════════════
// RULE-BASED RECOMMENDATIONS ENGINE
// Inputs: severity (from MQ6 gas_leakages), level (DYP-L06 %), ppm (MQ6)
// ═══════════════════════════════════════════════════════════════════════════
const getRecommendations = (severity, level, ppm) => {
  if (severity === 'high') return [
    { icon: '🚨', text: 'EVACUATE the area immediately — do not delay', urgent: true },
    { icon: '⚡', text: 'Cut all electrical power at the mains switchboard', urgent: true },
    { icon: '🚫', text: 'Do NOT operate any switches, lighters or appliances', urgent: true },
    { icon: '📞', text: 'Call emergency services (fire department) immediately', urgent: false },
    { icon: '🪟', text: 'Open all windows and doors if safe to do so', urgent: false },
    { icon: '🔥', text: 'Eliminate ALL ignition sources in the vicinity', urgent: false },
    ppm && ppm > 800
      ? { icon: '☣️', text: `Extremely high concentration (~${Math.round(ppm)} ppm) — stay well clear`, urgent: true }
      : { icon: '📊', text: `MQ6 reading ~${ppm ? Math.round(ppm) : '—'} ppm — well above safe threshold`, urgent: false },
  ]
  if (severity === 'low') return [
    { icon: '⚠️', text: 'Ventilate the area immediately — open windows now', urgent: true },
    { icon: '🔍', text: 'Inspect cylinder valve and all pipe connections', urgent: false },
    { icon: '🚭', text: 'No open flames, smoking or ignition sources nearby', urgent: false },
    { icon: '👁️', text: 'Monitor MQ6 sensor readings closely for escalation', urgent: false },
    { icon: '🔧', text: 'Check regulator connection and hose integrity', urgent: false },
    ppm ? { icon: '📊', text: `Current MQ6: ~${Math.round(ppm)} ppm — act before this increases`, urgent: false }
         : { icon: '📊', text: 'Track PPM trend in the Analytics tab', urgent: false },
  ]
  if (level < 20) return [
    { icon: '📦', text: 'Cylinder critically low — arrange immediate replacement', urgent: true },
    { icon: '📋', text: 'Contact your gas supplier or retailer today', urgent: false },
    { icon: '🕐', text: 'Estimated less than a week of gas remaining at current rate', urgent: false },
    { icon: '📊', text: 'Review consumption in the Analytics tab', urgent: false },
  ]
  if (level < 40) return [
    { icon: '📦', text: 'Cylinder below 40% — schedule a refill within the week', urgent: false },
    { icon: '📊', text: 'Track usage patterns in the Analytics tab', urgent: false },
    { icon: '🔍', text: 'Inspect connections during your next cylinder change', urgent: false },
  ]
  return [
    { icon: '✅', text: 'System operating normally — all sensors within safe range', urgent: false },
    { icon: '📊', text: 'Gas level and MQ6 leakage readings are both nominal', urgent: false },
    { icon: '🔍', text: 'Continue routine monthly inspection of connections and valves', urgent: false },
  ]
}

const C = {
  safe: { main: '#00e5a0', dim: 'rgba(0,229,160,0.12)',  border: 'rgba(0,229,160,0.25)',  glow: '0 0 24px rgba(0,229,160,0.3)' },
  low:  { main: '#ffb020', dim: 'rgba(255,176,32,0.12)', border: 'rgba(255,176,32,0.25)', glow: '0 0 24px rgba(255,176,32,0.3)' },
  high: { main: '#ff4560', dim: 'rgba(255,69,96,0.12)',  border: 'rgba(255,69,96,0.25)',  glow: '0 0 24px rgba(255,69,96,0.4)' },
}
const levelColor = l => l < 20 ? C.high : l < 40 ? C.low : C.safe
const isConfigured = () => !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY)

let demoIdx = 0
const demoSevs = ['safe','safe','safe','safe','low','safe','safe','high','safe','safe','safe','safe']
const demoPpm  = [45, 52, 48, 61, 220, 55, 44, 650, 51, 48, 53, 50]
const genDemoLevel = prev => Math.max(5, Math.min(100, (prev ?? 72) + (Math.random() - 0.48) * 1.5))

const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const fmtDate = d => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' })
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// ── Components ─────────────────────────────────────────────────────────────
function StatusDot({ online }) {
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background: online?'#00e5a0':'#ff4560', boxShadow: online?'0 0 8px #00e5a0':'0 0 8px #ff4560', animation: online?'pulseGreen 2s ease infinite':'pulseRed 1.5s ease infinite', flexShrink:0 }} />
}
function Chip({ label, color, bg, border }) {
  return <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 10px', borderRadius:20, background: bg||'rgba(255,255,255,0.06)', border:`1px solid ${border||'rgba(255,255,255,0.1)'}`, fontFamily:'var(--font-mono)', fontSize:11, fontWeight:500, color: color||'var(--text-2)', letterSpacing:'0.05em', whiteSpace:'nowrap' }}>{label}</span>
}
function Card({ children, style, accent, glow }) {
  return <div style={{ background:'var(--surface)', border:`1px solid ${accent?accent+'30':'var(--border)'}`, borderRadius:'var(--r)', padding:'20px', boxShadow: glow||'var(--shadow)', transition:'box-shadow 0.3s, border-color 0.3s', ...style }}>{children}</div>
}
function SectionTitle({ children }) {
  return <div style={{ fontFamily:'var(--font-mono)', fontSize:11, fontWeight:600, color:'var(--text-3)', letterSpacing:'0.12em', textTransform:'uppercase', marginBottom:16 }}>{children}</div>
}

function PpmBar({ ppm }) {
  const MAX = 1000
  const pct = Math.min(100, ((ppm || 0) / MAX) * 100)
  const col  = ppm >= 500 ? '#ff4560' : ppm >= 200 ? '#ffb020' : '#00e5a0'
  return (
    <div>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>
        <span>MQ6 Gas Concentration</span>
        <span style={{ color:col, fontWeight:600 }}>{ppm != null ? `~${Math.round(ppm)} ppm` : '— ppm'}</span>
      </div>
      <div style={{ background:'var(--surface3)', borderRadius:6, height:8, overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', borderRadius:6, background:`linear-gradient(90deg, #00e5a0, ${col})`, boxShadow: ppm>100?`0 0 8px ${col}80`:'none', transition:'width 1s ease, background 0.5s' }} />
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:4, fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)' }}>
        <span>0</span><span>200</span><span>500</span><span>1000 ppm</span>
      </div>
    </div>
  )
}

function ArcGauge({ value, color, size=160 }) {
  const r=size*0.38, cx=size/2, cy=size/2
  const startAngle=-210, totalArc=240
  const valueArc=(value/100)*totalArc
  const toRad=a=>(a*Math.PI)/180
  const arcPath=(startA,endA)=>{
    const x1=cx+r*Math.cos(toRad(startA)),y1=cy+r*Math.sin(toRad(startA))
    const x2=cx+r*Math.cos(toRad(endA)),y2=cy+r*Math.sin(toRad(endA))
    const la=Math.abs(endA-startA)>180?1:0
    return `M ${x1} ${y1} A ${r} ${r} 0 ${la} 1 ${x2} ${y2}`
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow:'visible' }}>
      <path d={arcPath(startAngle,startAngle+totalArc)} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={size*0.075} strokeLinecap="round" />
      <path d={arcPath(startAngle,startAngle+valueArc)} fill="none" stroke={color} strokeWidth={size*0.075} strokeLinecap="round" style={{ filter:`drop-shadow(0 0 6px ${color})`, transition:'all 0.8s cubic-bezier(.4,0,.2,1)' }} />
      <text x={cx} y={cy-4} textAnchor="middle" fill={color} style={{ fontFamily:"'Outfit',sans-serif", fontSize:size*0.22, fontWeight:800, transition:'fill 0.4s' }}>{Math.round(value)}%</text>
      <text x={cx} y={cy+size*0.13} textAnchor="middle" fill="var(--text-3)" style={{ fontFamily:"'DM Mono',monospace", fontSize:size*0.075, letterSpacing:'0.1em' }}>GAS LEVEL</text>
    </svg>
  )
}

function Sparkline({ data, color, height=40 }) {
  if (!data||data.length<2) return null
  const w=200,h=height,pad=4
  const min=Math.min(...data),max=Math.max(...data),range=max-min||1
  const pts=data.map((v,i)=>[pad+(i/(data.length-1))*(w-pad*2),h-pad-((v-min)/range)*(h-pad*2)])
  const line=pts.map(p=>p.join(',')).join(' ')
  const area=`M${pad},${h} L${pts.map(p=>p.join(',')).join(' L')} L${w-pad},${h} Z`
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display:'block' }} preserveAspectRatio="none">
      <defs><linearGradient id={`sg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.25"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
      <path d={area} fill={`url(#sg-${color.replace('#','')})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function BarChart({ data, color }) {
  if (!data||data.length===0) return <div style={{ height:80, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-3)', fontFamily:'var(--font-mono)', fontSize:11 }}>No data yet</div>
  const max=Math.max(...data.map(d=>d.value),1)
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:4, height:80 }}>
      {data.map((d,i)=>(
        <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4, height:'100%', justifyContent:'flex-end' }}>
          <div style={{ width:'100%', borderRadius:'3px 3px 0 0', height:`${(d.value/max)*64}px`, minHeight:d.value>0?3:0, background:color, boxShadow:d.value>0?`0 0 8px ${color}80`:'none', transition:'height 0.6s cubic-bezier(.4,0,.2,1)', opacity:d.value>0?1:0.15 }} />
          <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)' }}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}

function DualBarChart({ data }) {
  if (!data||data.length===0) return <div style={{ height:80, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-3)', fontFamily:'var(--font-mono)', fontSize:11 }}>No data yet</div>
  const max=Math.max(...data.map(d=>Math.max(d.high,d.low)),1)
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap:6, height:80 }}>
      {data.map((d,i)=>(
        <div key={i} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:4, height:'100%', justifyContent:'flex-end' }}>
          <div style={{ width:'100%', display:'flex', gap:2, alignItems:'flex-end', justifyContent:'center' }}>
            <div style={{ flex:1, borderRadius:'2px 2px 0 0', height:`${(d.high/max)*60}px`, minHeight:d.high>0?3:0, background:'#ff4560', opacity:d.high>0?1:0.12 }} />
            <div style={{ flex:1, borderRadius:'2px 2px 0 0', height:`${(d.low/max)*60}px`,  minHeight:d.low>0?3:0,  background:'#ffb020', opacity:d.low>0?1:0.12 }} />
          </div>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)' }}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab,setTab]                     = useState('dashboard')
  const [gasLevel,setGasLevel]           = useState(72)
  const [levelHistory,setLevelHistory]   = useState([72])
  const [connected,setConnected]         = useState(false)
  const [lastSeen,setLastSeen]           = useState(new Date())
  const [loaded,setLoaded]               = useState(false)
  const [demoMode]                       = useState(!isConfigured())
  // MQ6 state
  const [severity,setSeverity]           = useState('safe')
  const [currentPpm,setCurrentPpm]       = useState(null)
  const [currentRaw,setCurrentRaw]       = useState(null)
  const [ppmHistory,setPpmHistory]       = useState([])
  const [alarmBanner,setAlarmBanner]     = useState(false)
  const [alerts,setAlerts]               = useState([])
  const [totalLeaks,setTotalLeaks]       = useState(0)
  // Analytics
  const [weeklyUsage,setWeeklyUsage]     = useState([])
  const [weeklyLeaks,setWeeklyLeaks]     = useState([])
  const [weeklyLeaksBySev,setWeeklyLeaksBySev] = useState([])
  const [weeklyPpm,setWeeklyPpm]         = useState([])
  const [avgPpm7d,setAvgPpm7d]           = useState(null)
  const [maxPpm7d,setMaxPpm7d]           = useState(null)
  const [highLeaks7d,setHighLeaks7d]     = useState(0)
  const [lowLeaks7d,setLowLeaks7d]       = useState(0)

  const audioCtx   = useRef(null)
  const alarmTimer = useRef(null)

  const playAlarm = useCallback(() => {
    try {
      if (!audioCtx.current) audioCtx.current = new AudioContext()
      const ctx = audioCtx.current
      [[880,0],[660,0.2],[880,0.4],[660,0.6]].forEach(([freq,t]) => {
        const osc=ctx.createOscillator(),gain=ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.type='sawtooth'; osc.frequency.value=freq
        gain.gain.setValueAtTime(0.18,ctx.currentTime+t)
        gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+t+0.18)
        osc.start(ctx.currentTime+t); osc.stop(ctx.currentTime+t+0.2)
      })
    } catch(_) {}
  }, [])

  const handleLeakEvent = useCallback((sev, id, ts, ppm, raw) => {
    setSeverity(sev)
    setLastSeen(new Date(ts || Date.now()))
    if (ppm != null) { setCurrentPpm(ppm); setPpmHistory(h => [...h.slice(-59), ppm]) }
    if (raw != null)   setCurrentRaw(raw)
    if (sev !== 'safe') {
      const alert = { id: id||Date.now(), severity:sev, time:fmtTime(ts||Date.now()), date:fmtDate(ts||Date.now()),
        msg: sev==='high'?'CRITICAL gas leakage detected!':'Minor gas leakage detected', ppm, raw }
      setAlerts(prev => [alert, ...prev.slice(0,99)])
      if (sev === 'high') {
        setTotalLeaks(t => t+1); setAlarmBanner(true); playAlarm()
        clearInterval(alarmTimer.current); alarmTimer.current = setInterval(playAlarm, 2500)
      }
    } else { setAlarmBanner(false); clearInterval(alarmTimer.current) }
  }, [playAlarm])

  useEffect(() => {
    if (demoMode) {
      setTimeout(() => setLoaded(true), 300)
      const DL = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
      setWeeklyLeaks(DL.map((l,i) => ({ label:l, value:[0,2,1,0,3,0,1][i] })))
      setWeeklyLeaksBySev(DL.map((l,i) => ({ label:l, high:[0,1,0,0,1,0,1][i], low:[0,1,1,0,2,0,0][i] })))
      setWeeklyUsage(DL.map((l,i) => ({ label:l, value:[68,65,63,61,58,55,72][i] })))
      setWeeklyPpm(DL.map((l,i) => ({ label:l, value:[48,95,62,44,180,55,72][i] })))
      setCurrentPpm(52); setCurrentRaw(218); setAvgPpm7d(79); setMaxPpm7d(650)
      setHighLeaks7d(2); setLowLeaks7d(5)
      setPpmHistory([48,52,55,61,58,44,50,220,55,48,52,65,48,53,50,44,48,52,55,650,55,48,50])
      setAlerts([
        { id:1, severity:'high', time:'10:24:15', date:'Jun 3', msg:'CRITICAL gas leakage detected!', ppm:650 },
        { id:2, severity:'low',  time:'08:12:03', date:'Jun 3', msg:'Minor gas leakage detected',     ppm:220 },
        { id:3, severity:'low',  time:'22:05:41', date:'Jun 2', msg:'Minor gas leakage detected',     ppm:195 },
      ])
      setTotalLeaks(7); setConnected(false)
      const iv = setInterval(() => {
        setGasLevel(prev => { const n=genDemoLevel(prev); setLevelHistory(h=>[...h.slice(-59),n]); return n })
        const i=demoIdx++%demoSevs.length; const sev=demoSevs[i]; const ppm=demoPpm[i]
        setSeverity(sev); setCurrentPpm(ppm); setPpmHistory(h=>[...h.slice(-59),ppm]); setLastSeen(new Date())
        if (sev!=='safe') {
          const a={id:Date.now(),severity:sev,ppm,time:fmtTime(Date.now()),date:fmtDate(Date.now()),msg:sev==='high'?'CRITICAL gas leakage detected!':'Minor gas leakage detected'}
          setAlerts(p=>[a,...p.slice(0,99)])
          if (sev==='high') { setTotalLeaks(t=>t+1); setAlarmBanner(true); playAlarm(); clearInterval(alarmTimer.current); alarmTimer.current=setInterval(playAlarm,2500) }
        } else { setAlarmBanner(false); clearInterval(alarmTimer.current) }
      }, 3500)
      return () => { clearInterval(iv); clearInterval(alarmTimer.current) }
    }

    let levelCh, leakCh
    async function init() {
      // Gas levels
      const { data:lvls } = await supabase.from('gas_levels').select('level_percent,created_at').order('created_at',{ascending:false}).limit(60)
      if (lvls?.length > 0) {
        const arr = lvls.map(r=>r.level_percent).reverse()
        setGasLevel(arr[arr.length-1]); setLevelHistory(arr); setLastSeen(new Date(lvls[0].created_at)); setConnected(true)
      }
      // MQ6 leakages — full fields
      const { data:leaks } = await supabase.from('gas_leakages').select('id,severity,raw_value,ppm_approx,created_at').order('created_at',{ascending:false}).limit(100)
      if (leaks?.length > 0) {
        const latest=leaks[0]
        setSeverity(latest.severity)
        if (latest.ppm_approx!=null) setCurrentPpm(latest.ppm_approx)
        if (latest.raw_value!=null)  setCurrentRaw(latest.raw_value)
        setPpmHistory(leaks.slice(0,60).map(r=>r.ppm_approx??0).reverse())
        setAlerts(leaks.map(r=>({ id:r.id, severity:r.severity, time:fmtTime(r.created_at), date:fmtDate(r.created_at),
          msg:r.severity==='high'?'CRITICAL gas leakage detected!':r.severity==='low'?'Minor gas leakage detected':'System reading — safe',
          ppm:r.ppm_approx, raw:r.raw_value })))
        setTotalLeaks(leaks.filter(r=>r.severity!=='safe').length)
        setConnected(true)
      }
      // Weekly analytics
      const sevenAgo = new Date(Date.now()-7*86400000).toISOString()
      const { data:wLvls } = await supabase.from('gas_levels').select('level_percent,created_at').gte('created_at',sevenAgo)
      if (wLvls?.length > 0) {
        const sums={},cnts={}; DAYS.forEach(d=>{sums[d]=0;cnts[d]=0})
        wLvls.forEach(r=>{ const d=DAYS[new Date(r.created_at).getDay()]; sums[d]+=r.level_percent; cnts[d]++ })
        setWeeklyUsage(DAYS.map(d=>({ label:d.slice(0,3), value:cnts[d]>0?Math.round(sums[d]/cnts[d]):0 })))
      } else { setWeeklyUsage(DAYS.map(d=>({ label:d.slice(0,3), value:0 }))) }

      const { data:wLeaks } = await supabase.from('gas_leakages').select('severity,ppm_approx,created_at').gte('created_at',sevenAgo)
      if (wLeaks?.length > 0) {
        const counts={},bySev={},ppmS={},ppmC={}
        DAYS.forEach(d=>{ counts[d]=0; bySev[d]={high:0,low:0}; ppmS[d]=0; ppmC[d]=0 })
        let sumP=0,cntP=0,maxP=0,cH=0,cL=0
        wLeaks.forEach(r=>{
          const d=DAYS[new Date(r.created_at).getDay()]
          if (r.severity!=='safe') counts[d]++
          if (r.severity==='high') { bySev[d].high++; cH++ }
          if (r.severity==='low')  { bySev[d].low++;  cL++ }
          if (r.ppm_approx!=null) { ppmS[d]+=r.ppm_approx; ppmC[d]++; sumP+=r.ppm_approx; cntP++; if(r.ppm_approx>maxP) maxP=r.ppm_approx }
        })
        setWeeklyLeaks(DAYS.map(d=>({ label:d.slice(0,3), value:counts[d] })))
        setWeeklyLeaksBySev(DAYS.map(d=>({ label:d.slice(0,3), high:bySev[d].high, low:bySev[d].low })))
        setWeeklyPpm(DAYS.map(d=>({ label:d.slice(0,3), value:ppmC[d]>0?Math.round(ppmS[d]/ppmC[d]):0 })))
        setAvgPpm7d(cntP>0?Math.round(sumP/cntP):null); setMaxPpm7d(maxP>0?Math.round(maxP):null)
        setHighLeaks7d(cH); setLowLeaks7d(cL)
      } else {
        setWeeklyLeaks(DAYS.map(d=>({label:d.slice(0,3),value:0}))); setWeeklyLeaksBySev(DAYS.map(d=>({label:d.slice(0,3),high:0,low:0}))); setWeeklyPpm(DAYS.map(d=>({label:d.slice(0,3),value:0})))
      }
      setLoaded(true)
    }
    init()

    levelCh = supabase.channel('rt-levels').on('postgres_changes',{event:'INSERT',schema:'public',table:'gas_levels'},p=>{
      setGasLevel(p.new.level_percent); setLevelHistory(h=>[...h.slice(-59),p.new.level_percent])
      setLastSeen(new Date(p.new.created_at)); setConnected(true)
    }).subscribe()

    leakCh = supabase.channel('rt-leakages').on('postgres_changes',{event:'INSERT',schema:'public',table:'gas_leakages'},p=>{
      const {severity:sev,id,created_at,ppm_approx,raw_value} = p.new
      handleLeakEvent(sev,id,created_at,ppm_approx,raw_value); setConnected(true)
      if (ppm_approx!=null) {
        const day=DAYS[new Date(created_at).getDay()].slice(0,3)
        setWeeklyPpm(prev=>prev.map(d=>d.label===day?{...d,value:Math.round((d.value+ppm_approx)/2)}:d))
      }
      if (sev!=='safe') {
        const day=DAYS[new Date(created_at).getDay()].slice(0,3)
        setWeeklyLeaks(prev=>prev.map(d=>d.label===day?{...d,value:d.value+1}:d))
        setWeeklyLeaksBySev(prev=>prev.map(d=>d.label!==day?d:{...d,high:d.high+(sev==='high'?1:0),low:d.low+(sev==='low'?1:0)}))
        if (sev==='high') setHighLeaks7d(n=>n+1)
        if (sev==='low')  setLowLeaks7d(n=>n+1)
      }
    }).subscribe()

    return () => { supabase.removeChannel(levelCh); supabase.removeChannel(leakCh); clearInterval(alarmTimer.current) }
  }, [demoMode, handleLeakEvent, playAlarm])

  const sCol    = C[severity]
  const lCol    = levelColor(gasLevel)
  const rules   = getRecommendations(severity, gasLevel, currentPpm)
  const estDays = Math.max(0, Math.ceil(gasLevel / 2.1))
  const nonSafeAlerts = alerts.filter(a => a.severity !== 'safe')

  const navItems = [
    { id:'dashboard', label:'Dashboard', icon:'◈' },
    { id:'alerts',    label:'Alerts',    icon:'◉', badge: nonSafeAlerts.length },
    { id:'analytics', label:'Analytics', icon:'◎' },
    { id:'device',    label:'Device',    icon:'◇' },
  ]

  if (!loaded) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
      <div style={{ width:40, height:40, border:'2px solid var(--border2)', borderTopColor:'#00e5a0', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
      <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-3)', letterSpacing:'0.1em' }}>INITIALISING</span>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg)' }}>
      {/* HEADER */}
      <header style={{ position:'sticky', top:0, zIndex:200, background:'rgba(10,14,26,0.9)', backdropFilter:'blur(16px)', borderBottom:'1px solid var(--border)', padding:'0 20px', height:56, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:32, height:32, borderRadius:10, background:'linear-gradient(135deg,#ff6b35,#ff4560)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, boxShadow:'0 0 16px rgba(255,69,96,0.4)' }}>🔥</div>
          <div>
            <div style={{ fontFamily:'var(--font-disp)', fontSize:17, fontWeight:800, lineHeight:1, letterSpacing:'-0.02em' }}>GasWatch <span style={{ color:'#4d8eff' }}>Pro</span></div>
            <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)', letterSpacing:'0.12em' }}>{demoMode?'DEMO MODE':'LIVE · IOT MONITORING'}</div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>{lastSeen.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 8px', borderRadius:20, background:'var(--surface2)', border:'1px solid var(--border)' }}>
            <StatusDot online={connected} />
            <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:connected?'#00e5a0':'#ff4560' }}>{connected?'ONLINE':demoMode?'DEMO':'OFFLINE'}</span>
          </div>
          <Chip label={severity.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
        </div>
      </header>

      {/* ALARM BANNER */}
      {alarmBanner && (
        <div style={{ position:'sticky', top:56, zIndex:190, background:'rgba(255,69,96,0.12)', borderBottom:'1px solid rgba(255,69,96,0.3)', padding:'12px 20px', display:'flex', alignItems:'center', justifyContent:'space-between', animation:'shimmer 0.8s ease infinite' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:22 }}>🚨</span>
            <div>
              <div style={{ fontFamily:'var(--font-disp)', fontWeight:700, color:'#ff4560', fontSize:14 }}>CRITICAL GAS LEAKAGE DETECTED{currentPpm?` · ~${Math.round(currentPpm)} ppm`:''}</div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'rgba(255,69,96,0.8)', marginTop:2 }}>Evacuate immediately · Cut power · Call emergency services</div>
            </div>
          </div>
          <button onClick={()=>{ setAlarmBanner(false); clearInterval(alarmTimer.current) }} style={{ padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:600, background:'#ff4560', color:'#fff', fontFamily:'var(--font-body)', boxShadow:'0 0 16px rgba(255,69,96,0.4)' }}>Dismiss</button>
        </div>
      )}

      {/* NAV */}
      <nav style={{ background:'rgba(10,14,26,0.8)', backdropFilter:'blur(12px)', borderBottom:'1px solid var(--border)', display:'flex', padding:'0 12px', overflowX:'auto', gap:0, WebkitOverflowScrolling:'touch' }}>
        {navItems.map(n => (
          <button key={n.id} onClick={()=>setTab(n.id)} style={{ padding:'14px 18px', fontSize:13, fontWeight:600, fontFamily:'var(--font-body)', color:tab===n.id?'#f0f4ff':'var(--text-3)', borderBottom:`2px solid ${tab===n.id?'#4d8eff':'transparent'}`, borderRadius:0, whiteSpace:'nowrap', transition:'color 0.2s', display:'flex', alignItems:'center', gap:6 }}>
            <span>{n.icon}</span>{n.label}
            {n.badge>0 && <span style={{ background:'#ff4560', color:'#fff', fontSize:9, fontWeight:700, borderRadius:10, padding:'1px 5px', fontFamily:'var(--font-mono)' }}>{n.badge>99?'99+':n.badge}</span>}
          </button>
        ))}
      </nav>

      <main style={{ padding:'20px', maxWidth:960, margin:'0 auto' }} className="fade-up">

        {/* ════ DASHBOARD ════ */}
        {tab==='dashboard' && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))', gap:16, marginBottom:16 }}>
              {/* DYP-L06 gauge */}
              <Card accent={lCol.main} glow={lCol.glow} style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                <SectionTitle>Cylinder Level · DYP-L06</SectionTitle>
                <ArcGauge value={gasLevel} color={lCol.main} size={160} />
                <div style={{ marginTop:12, textAlign:'center', width:'100%' }}>
                  <Chip label={gasLevel<20?'⚠ Replace Now':gasLevel<40?'⚠ Plan Refill':'✓ Sufficient'} color={lCol.main} border={lCol.border} bg={lCol.dim} />
                  <div style={{ marginTop:12 }}><Sparkline data={levelHistory} color={lCol.main} height={44} /></div>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)', marginTop:4, letterSpacing:'0.08em' }}>LAST {Math.min(levelHistory.length,60)} READINGS</div>
                </div>
              </Card>

              {/* MQ6 status */}
              <Card accent={sCol.main} glow={severity!=='safe'?sCol.glow:undefined} style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:10 }}>
                <SectionTitle>Leakage Status · MQ6</SectionTitle>
                <div style={{ width:88, height:88, borderRadius:'50%', background:sCol.dim, border:`1.5px solid ${sCol.border}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:38, boxShadow:severity!=='safe'?sCol.glow:undefined, animation:severity==='high'?'pulseRed 1.2s ease infinite':severity==='safe'?'pulseGreen 3s ease infinite':undefined }}>
                  {severity==='high'?'🚨':severity==='low'?'⚠️':'✅'}
                </div>
                <div style={{ fontFamily:'var(--font-disp)', fontSize:24, fontWeight:800, color:sCol.main, letterSpacing:'-0.02em' }}>{severity==='high'?'CRITICAL':severity==='low'?'LOW LEAK':'ALL SAFE'}</div>
                <Chip label={severity.toUpperCase()} color={sCol.main} border={sCol.border} bg={sCol.dim} />
                <div style={{ width:'100%', marginTop:6 }}><PpmBar ppm={currentPpm} /></div>
                {ppmHistory.length>2 && (
                  <div style={{ width:'100%', marginTop:4 }}>
                    <Sparkline data={ppmHistory} color={sCol.main} height={32} />
                    <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)', marginTop:2, letterSpacing:'0.08em', textAlign:'center' }}>MQ6 PPM TREND</div>
                  </div>
                )}
              </Card>

              {/* Quick Stats */}
              <Card>
                <SectionTitle>Quick Stats</SectionTitle>
                {[
                  { label:'Current Level',     val:`${Math.round(gasLevel)}%`,                             col:lCol.main },
                  { label:'Est. Days Left',     val:`~${estDays}d`,                                        col:'#4d8eff' },
                  { label:'MQ6 Reading',        val:currentPpm!=null?`~${Math.round(currentPpm)} ppm`:'— ppm', col:sCol.main },
                  { label:'MQ6 Raw ADC',        val:currentRaw!=null?currentRaw:'—',                       col:'var(--text-2)' },
                  { label:'Total Leak Events',  val:totalLeaks,                                            col:'#ff4560' },
                  { label:'Avg Daily Use',       val:'~2.1%/day',                                          col:'#00e5a0' },
                ].map((s,i,arr)=>(
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:i<arr.length-1?'1px solid var(--border)':'none' }}>
                    <span style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-2)' }}>{s.label}</span>
                    <span style={{ fontFamily:'var(--font-disp)', fontSize:18, fontWeight:800, color:s.col }}>{s.val}</span>
                  </div>
                ))}
              </Card>
            </div>

            {/* Safety Recommendations */}
            <Card accent={sCol.main}>
              <SectionTitle>⚡ Safety Recommendations</SectionTitle>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:10 }}>
                {rules.map((r,i)=>(
                  <div key={i} style={{ padding:'12px 14px', borderRadius:'var(--r-sm)', background:r.urgent?sCol.dim:'var(--surface2)', border:`1px solid ${r.urgent?sCol.border:'var(--border)'}`, display:'flex', alignItems:'flex-start', gap:10 }}>
                    <span style={{ fontSize:16, flexShrink:0 }}>{r.icon}</span>
                    <span style={{ fontFamily:'var(--font-body)', fontSize:13, lineHeight:'1.5', color:r.urgent?sCol.main:'var(--text-2)', fontWeight:r.urgent?600:400 }}>{r.text}</span>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}

        {/* ════ ALERTS ════ */}
        {tab==='alerts' && (
          <Card>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
              <div>
                <SectionTitle>Alert History · MQ6</SectionTitle>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--text-3)' }}>{nonSafeAlerts.length} leak event{nonSafeAlerts.length!==1?'s':''} recorded</div>
              </div>
              <button onClick={()=>setAlerts([])} style={{ padding:'6px 14px', borderRadius:8, fontSize:12, fontWeight:600, background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text-2)', fontFamily:'var(--font-body)' }}>Clear All</button>
            </div>
            {nonSafeAlerts.length===0 && (
              <div style={{ textAlign:'center', padding:'48px 20px', color:'var(--text-3)' }}>
                <div style={{ fontSize:36, marginBottom:10 }}>🛡️</div>
                <div style={{ fontFamily:'var(--font-body)', fontSize:14 }}>No leakage events recorded</div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:11, marginTop:4 }}>All MQ6 readings are safe</div>
              </div>
            )}
            {nonSafeAlerts.map(a=>{ const ac=C[a.severity]; return (
              <div key={a.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 16px', borderRadius:'var(--r-sm)', marginBottom:8, background:ac.dim, border:`1px solid ${ac.border}` }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                  <span style={{ fontSize:20 }}>{a.severity==='high'?'🚨':'⚠️'}</span>
                  <div>
                    <div style={{ fontFamily:'var(--font-body)', fontSize:13, fontWeight:600, color:ac.main }}>{a.msg}</div>
                    <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', marginTop:3, display:'flex', gap:10, flexWrap:'wrap' }}>
                      <span>{a.date} · {a.time}</span>
                      {a.ppm!=null && <span style={{ color:ac.main }}>~{Math.round(a.ppm)} ppm</span>}
                      {a.raw!=null && <span>raw ADC: {a.raw}</span>}
                    </div>
                  </div>
                </div>
                <Chip label={a.severity.toUpperCase()} color={ac.main} border={ac.border} bg={ac.dim} />
              </div>
            )})}
          </Card>
        )}

        {/* ════ ANALYTICS ════ */}
        {tab==='analytics' && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))', gap:12, marginBottom:16 }}>
              {[
                { label:'Avg Daily Use',    val:'~2.1%',                                   col:'#4d8eff' },
                { label:'Days Remaining',   val:`~${estDays}d`,                            col:'#00e5a0' },
                { label:'Avg PPM (7d)',      val:avgPpm7d!=null?`${avgPpm7d} ppm`:'—',     col:'#ffb020' },
                { label:'Peak PPM (7d)',     val:maxPpm7d!=null?`${maxPpm7d} ppm`:'—',     col:'#ff4560' },
                { label:'High Leaks (7d)',   val:highLeaks7d,                              col:'#ff4560' },
                { label:'Low Leaks (7d)',    val:lowLeaks7d,                               col:'#ffb020' },
              ].map((s,i)=>(
                <Card key={i} accent={s.col} style={{ textAlign:'center', padding:'18px 12px' }}>
                  <div style={{ fontFamily:'var(--font-disp)', fontSize:28, fontWeight:800, color:s.col, lineHeight:1 }}>{s.val}</div>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:9, color:'var(--text-3)', marginTop:8, letterSpacing:'0.06em', textTransform:'uppercase' }}>{s.label}</div>
                </Card>
              ))}
            </div>

            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(270px,1fr))', gap:16, marginBottom:16 }}>
              <Card>
                <SectionTitle>Weekly Gas Usage (avg %)</SectionTitle>
                <BarChart data={weeklyUsage} color="#4d8eff" />
                <div style={{ marginTop:10, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>Est. {estDays} days remaining</div>
              </Card>
              <Card>
                <SectionTitle>Weekly Leak Events · MQ6</SectionTitle>
                <DualBarChart data={weeklyLeaksBySev} />
                <div style={{ display:'flex', gap:16, marginTop:10 }}>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'#ff4560' }}>■ High: {highLeaks7d}</span>
                  <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'#ffb020' }}>■ Low: {lowLeaks7d}</span>
                </div>
              </Card>
            </div>

            <Card style={{ marginBottom:16 }}>
              <SectionTitle>Weekly Average MQ6 PPM</SectionTitle>
              <BarChart data={weeklyPpm} color="#ffb020" />
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:10, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>
                <span>7d avg: {avgPpm7d!=null?`${avgPpm7d} ppm`:'—'}</span>
                <span style={{ color:maxPpm7d>500?'#ff4560':maxPpm7d>200?'#ffb020':'var(--text-3)' }}>peak: {maxPpm7d!=null?`${maxPpm7d} ppm`:'—'}</span>
              </div>
            </Card>

            <Card>
              <SectionTitle>Gas Level Trend (Last {Math.min(levelHistory.length,60)} Readings)</SectionTitle>
              <div style={{ height:80 }}><Sparkline data={levelHistory} color="#4d8eff" height={80} /></div>
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)' }}>
                <span>oldest</span><span>current: {Math.round(gasLevel)}%</span>
              </div>
            </Card>
          </>
        )}

        {/* ════ DEVICE ════ */}
        {tab==='device' && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))', gap:16, marginBottom:16 }}>
              <Card accent="#4d8eff">
                <SectionTitle>ESP32 Status</SectionTitle>
                {[
                  { k:'Connection',  v:connected?'Online':demoMode?'Demo Mode':'Offline', col:connected?'#00e5a0':demoMode?'#ffb020':'#ff4560' },
                  { k:'Last Data',   v:lastSeen.toLocaleTimeString(), col:null },
                  { k:'Protocol',    v:'HTTP POST → Supabase', col:null },
                  { k:'Send Rate',   v:'Every 5 seconds', col:null },
                  { k:'Firmware',    v:'GasWatch v2.1.0', col:'#4d8eff' },
                  { k:'Data Tables', v:'gas_levels · gas_leakages', col:null },
                ].map((r,i,arr)=>(
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:i<arr.length-1?'1px solid var(--border)':'none' }}>
                    <span style={{ fontFamily:'var(--font-body)', fontSize:13, color:'var(--text-3)' }}>{r.k}</span>
                    <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:r.col||'var(--text-2)' }}>{r.v}</span>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionTitle>Sensor Health</SectionTitle>
                {[
                  { name:'MQ6 Gas Sensor',     type:'Leakage · severity, ppm_approx, raw_value', health:connected?98:0,  col:'#00e5a0' },
                  { name:'DYP-L06 Ultrasonic', type:'Gas Level · level_percent via UART Modbus', health:connected?100:0, col:'#4d8eff' },
                ].map((s,i)=>(
                  <div key={i} style={{ padding:'14px', background:'var(--surface2)', borderRadius:'var(--r-sm)', border:'1px solid var(--border)', marginBottom:10 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                      <div>
                        <div style={{ fontFamily:'var(--font-body)', fontSize:13, fontWeight:600, color:'var(--text-1)' }}>{s.name}</div>
                        <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', marginTop:2 }}>{s.type}</div>
                      </div>
                      <Chip label={connected?'ACTIVE':'OFFLINE'} color={connected?'#00e5a0':'#ff4560'} />
                    </div>
                    <div style={{ background:'var(--surface3)', borderRadius:4, height:5, overflow:'hidden' }}>
                      <div style={{ width:`${s.health}%`, height:'100%', background:s.col, borderRadius:4, boxShadow:`0 0 8px ${s.col}80`, transition:'width 1s ease' }} />
                    </div>
                    <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', textAlign:'right', marginTop:4 }}>{s.health}% health</div>
                  </div>
                ))}
                {/* Live MQ6 summary panel */}
                <div style={{ padding:'14px', background:'var(--surface2)', borderRadius:'var(--r-sm)', border:`1px solid ${sCol.border}` }}>
                  <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)', marginBottom:8, letterSpacing:'0.08em', textTransform:'uppercase' }}>Live MQ6 Readings</div>
                  {[
                    { k:'Severity',    v:severity.toUpperCase(),                                          col:sCol.main },
                    { k:'PPM (approx)',v:currentPpm!=null?`~${Math.round(currentPpm)} ppm`:'—',           col:sCol.main },
                    { k:'Raw ADC',     v:currentRaw!=null?currentRaw:'—',                                 col:'var(--text-2)' },
                    { k:'7d Avg PPM',  v:avgPpm7d!=null?`${avgPpm7d} ppm`:'—',                           col:'var(--text-2)' },
                    { k:'7d Peak PPM', v:maxPpm7d!=null?`${maxPpm7d} ppm`:'—',                           col:maxPpm7d>500?'#ff4560':maxPpm7d>200?'#ffb020':'var(--text-2)' },
                  ].map((r,i,arr)=>(
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'7px 0', borderBottom:i<arr.length-1?'1px solid var(--border)':'none' }}>
                      <span style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)' }}>{r.k}</span>
                      <span style={{ fontFamily:'var(--font-mono)', fontSize:12, color:r.col }}>{r.v}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            <Card>
              <SectionTitle>Integration Setup</SectionTitle>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))', gap:10 }}>
                {[
                  { icon:'🔗', title:'ESP32 WiFi',   desc:'Set WIFI_SSID + WIFI_PASSWORD in firmware. ESP32 connects to your local network.' },
                  { icon:'🗄️', title:'Supabase',     desc:'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Netlify environment variables.' },
                  { icon:'📊', title:'MQ6 Table',    desc:'ESP32 POSTs severity, raw_value, and ppm_approx to gas_leakages every 5 seconds.' },
                  { icon:'📡', title:'Realtime',      desc:'Enable Realtime on gas_levels and gas_leakages in Supabase → Database → Replication.' },
                ].map((c,i)=>(
                  <div key={i} style={{ padding:'14px', background:'var(--surface2)', borderRadius:'var(--r-sm)', border:'1px solid var(--border)', display:'flex', gap:12 }}>
                    <span style={{ fontSize:20, flexShrink:0 }}>{c.icon}</span>
                    <div>
                      <div style={{ fontFamily:'var(--font-body)', fontSize:13, fontWeight:600, marginBottom:4 }}>{c.title}</div>
                      <div style={{ fontFamily:'var(--font-body)', fontSize:12, color:'var(--text-3)', lineHeight:1.5 }}>{c.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </main>

      {/* MOBILE NAV */}
      <div style={{ display:'none', position:'fixed', bottom:0, left:0, right:0, background:'rgba(10,14,26,0.95)', backdropFilter:'blur(16px)', borderTop:'1px solid var(--border)', padding:'6px 0 max(6px,env(safe-area-inset-bottom))', zIndex:200 }} id="mobile-nav">
        {navItems.map(n=>(
          <button key={n.id} onClick={()=>setTab(n.id)} style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', gap:3, padding:'6px 4px', position:'relative', color:tab===n.id?'#f0f4ff':'var(--text-3)' }}>
            <span style={{ fontSize:18 }}>{n.icon}</span>
            <span style={{ fontFamily:'var(--font-mono)', fontSize:9, fontWeight:500, letterSpacing:'0.06em' }}>{n.label}</span>
            {n.badge>0 && <span style={{ position:'absolute', top:2, right:'18%', background:'#ff4560', color:'#fff', fontSize:8, fontWeight:700, borderRadius:8, padding:'0 4px', fontFamily:'var(--font-mono)' }}>{n.badge}</span>}
          </button>
        ))}
      </div>
      <style>{`@media(max-width:640px){#mobile-nav{display:flex!important}body{padding-bottom:70px}}`}</style>
    </div>
  )
}
