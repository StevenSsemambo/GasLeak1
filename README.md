# 🔥 GasWatch Pro

**IoT Gas Level Monitoring & Leakage Detection System**  
ESP32 + DYP-L06 + MQ6 → Supabase → React PWA

---

## Quick Start

### 1. Clone & install
```bash
git clone https://github.com/YOUR_USERNAME/gaswatch-pro.git
cd gaswatch-pro
npm install
```

### 2. Set up Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor → New Query** and run `supabase_schema.sql`
3. Go to **Database → Replication** and enable both `gas_levels` and `gas_leakages` tables
4. Copy your **Project URL** and **anon/public key** from Settings → API

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env and fill in your Supabase credentials
```

### 4. Run locally
```bash
npm run dev
```

### 5. Deploy to Vercel
1. Push to GitHub
2. Import repo on [vercel.com](https://vercel.com)
3. Add environment variables: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
4. Deploy ✅

---

## Tech Stack
- **Frontend**: React 18 + Vite + PWA (vite-plugin-pwa)
- **Database**: Supabase (PostgreSQL + Realtime WebSocket)
- **Hardware**: ESP32 + MQ6 + DYP-L06 (see Integration Guide)

---

## Demo Mode
If `.env` is not configured, the app runs in **Demo Mode** with simulated sensor data so you can see the full UI before connecting hardware.
