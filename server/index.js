/**
 * AI Voice Receptionist — Free Stack
 * AI: Groq (Llama 3.3 70B) — Free
 * Voice: Web Speech API — Free
 * Hosting: Render.com — Free
 * DB: JSON file — Free
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Groq Client ─────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile"; // Best free model on Groq

async function callGroq(messages, systemPrompt) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      temperature: 0.6,
      max_tokens: 300,
      top_p: 0.9,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ─── Business Config ──────────────────────────────────────────────────────────
function getBusinessConfig() {
  const configPath = path.join(__dirname, "../data/config.json");
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }
  return {
    name: "City Medical Centre",
    industry: "hospital",
    tagline: "Your health, our priority",
    hours: "Monday to Saturday, 9 AM to 6 PM",
    address: "123 Main Street, City Centre",
    phone: "Available via this assistant",
    services: ["General Consultation", "Follow-up Visit", "Health Checkup", "Specialist Referral"],
    slotDuration: 30,
    workStart: "09:00",
    workEnd: "18:00",
    customFAQs: [],
    welcomeMessage: "Hello! Welcome to {NAME}. I'm your AI receptionist. How may I assist you today?",
  };
}

// ─── System Prompt (high quality, detailed) ───────────────────────────────────
function buildSystemPrompt(config) {
  return `You are Aria, a warm, professional, and highly capable AI receptionist for ${config.name} — ${config.tagline || "a trusted service provider"}.

ABOUT THE BUSINESS:
- Name: ${config.name}
- Industry: ${config.industry}
- Hours: ${config.hours}
- Address: ${config.address}
- Services offered: ${config.services.join(", ")}
${config.customFAQs.length > 0 ? `- Additional info: ${config.customFAQs.map(f => `${f.q}: ${f.a}`).join(" | ")}` : ""}

YOUR PERSONALITY:
- Warm, patient, and professional — like a 5-star hotel receptionist
- Speak naturally and conversationally, not robotic
- Be empathetic — if someone sounds worried or stressed, acknowledge it
- Confident but never pushy
- Use the caller's name once you know it

YOUR CAPABILITIES:
1. Answer questions about the business (hours, location, services, pricing queries)
2. Book appointments — collect: full name, phone number, preferred date, preferred time, and reason/service
3. Handle cancellations and rescheduling
4. Handle general FAQs naturally

BOOKING FLOW (follow this carefully):
- Ask for details ONE at a time — never bombard with multiple questions
- Order: name → phone → preferred date → preferred time → service/reason
- After collecting all details, confirm by reading everything back to the caller
- Once confirmed, output EXACTLY this on its own line (no extra text around it):
  SAVE_BOOKING:{"name":"...","phone":"...","date":"YYYY-MM-DD","time":"HH:MM","service":"...","notes":"..."}

RESPONSE RULES (very important):
- Keep responses SHORT — 1 to 3 sentences maximum
- This is a voice conversation — no bullet points, no lists, no markdown
- Natural spoken language only
- Never say "As an AI" or "I'm a language model"
- If you don't know something, say you'll get a human to follow up
- For medical/legal/financial questions: acknowledge concern, don't advise, offer to connect to staff
- End calls warmly when the caller says goodbye

TODAY'S DATE: ${new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
CURRENT TIME: ${new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
}

// ─── Session Store ────────────────────────────────────────────────────────────
const sessions = {}; // sessionId -> { history, config, createdAt }

function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      history: [],
      config: getBusinessConfig(),
      createdAt: Date.now(),
    };
  }
  return sessions[sessionId];
}

// Clean up old sessions every 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  Object.keys(sessions).forEach(id => {
    if (sessions[id].createdAt < cutoff) delete sessions[id];
  });
}, 30 * 60 * 1000);

// ─── Bookings Store ───────────────────────────────────────────────────────────
const BOOKINGS_FILE = path.join(__dirname, "../data/bookings.json");

function loadBookings() {
  try {
    if (!fs.existsSync(BOOKINGS_FILE)) return [];
    return JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf-8"));
  } catch { return []; }
}

function saveBooking(data) {
  const bookings = loadBookings();
  const booking = {
    id: `BK${Date.now()}`,
    ...data,
    status: "confirmed",
    source: "ai-agent",
    createdAt: new Date().toISOString(),
  };
  bookings.push(booking);
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  return booking;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Main chat endpoint — called by the voice widget
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, isFirst } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  const session = getOrCreateSession(sessionId);
  const config = session.config;

  try {
    let userMessage = message;

    // First message — generate greeting
    if (isFirst) {
      const greeting = config.welcomeMessage.replace("{NAME}", config.name);
      session.history.push({ role: "assistant", content: greeting });
      return res.json({ reply: greeting, booking: null });
    }

    session.history.push({ role: "user", content: userMessage });

    const rawReply = await callGroq(session.history, buildSystemPrompt(config));

    // Extract booking if present
    let reply = rawReply;
    let booking = null;
    const bookingMatch = rawReply.match(/SAVE_BOOKING:(\{[^}]+\})/);
    if (bookingMatch) {
      try {
        const bookingData = JSON.parse(bookingMatch[1]);
        booking = saveBooking(bookingData);
        reply = rawReply.replace(/SAVE_BOOKING:\{[^}]+\}/, "").trim();
        console.log("[BOOKING SAVED]", booking.id, booking.name);
      } catch (e) {
        console.error("Booking parse error:", e.message);
      }
    }

    session.history.push({ role: "assistant", content: reply });
    res.json({ reply, booking });

  } catch (err) {
    console.error("[CHAT ERROR]", err.message);
    res.status(500).json({ error: "AI unavailable", reply: "I'm sorry, I'm having a brief technical issue. Please try again in a moment." });
  }
});

// Get available slots
app.get("/api/slots/:date", (req, res) => {
  const config = getBusinessConfig();
  const bookings = loadBookings().filter(b => b.date === req.params.date && b.status !== "cancelled");
  const bookedTimes = new Set(bookings.map(b => b.time));

  const slots = [];
  const [sh, sm] = config.workStart.split(":").map(Number);
  const [eh, em] = config.workEnd.split(":").map(Number);
  let cur = sh * 60 + sm;
  const end = eh * 60 + em;

  while (cur < end) {
    const h = String(Math.floor(cur / 60)).padStart(2, "0");
    const m = String(cur % 60).padStart(2, "0");
    const t = `${h}:${m}`;
    slots.push({ time: t, available: !bookedTimes.has(t), booked: bookedTimes.has(t) ? bookings.find(b=>b.time===t)?.name : null });
    cur += config.slotDuration;
  }
  res.json(slots);
});

// Bookings CRUD
app.get("/api/bookings", (req, res) => res.json(loadBookings()));

app.post("/api/bookings", (req, res) => {
  const booking = saveBooking({ ...req.body, source: "manual" });
  res.json(booking);
});

app.patch("/api/bookings/:id", (req, res) => {
  const bookings = loadBookings();
  const idx = bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  bookings[idx] = { ...bookings[idx], ...req.body };
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  res.json(bookings[idx]);
});

app.delete("/api/bookings/:id", (req, res) => {
  let bookings = loadBookings().filter(b => b.id !== req.params.id);
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  res.json({ ok: true });
});

// Stats
app.get("/api/stats", (req, res) => {
  const b = loadBookings();
  const today = new Date().toISOString().split("T")[0];
  const thisMonth = new Date().toISOString().slice(0, 7);
  res.json({
    total: b.length,
    today: b.filter(x => x.date === today).length,
    confirmed: b.filter(x => x.status === "confirmed").length,
    cancelled: b.filter(x => x.status === "cancelled").length,
    thisMonth: b.filter(x => x.date?.startsWith(thisMonth)).length,
    aiBooked: b.filter(x => x.source === "ai-agent").length,
  });
});

// Config
app.get("/api/config", (req, res) => res.json(getBusinessConfig()));

app.post("/api/config", (req, res) => {
  const configPath = path.join(__dirname, "../data/config.json");
  fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Health
app.get("/health", (req, res) => res.json({ status: "ok", model: GROQ_MODEL, time: new Date().toISOString() }));

// Serve dashboard for all non-api routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/dashboard/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ AI Receptionist running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🤖 Model: ${GROQ_MODEL} (free via Groq)`);
});
