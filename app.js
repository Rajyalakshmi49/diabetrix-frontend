const API_BASE = 'https://Rajyalakshmi06-diabetrix-backend.hf.space/api';

'use strict';

// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
let APP = {
  user:        null,
  token:       null,
  profile:     {},
  readings:    [],
  medications: [],
  contacts:    [],
  steps:       0,
  safetyLog:   [],
  onboarded:   false,
};

let dashChart  = null;
let trendChart = null;
let lastReport = null;

// Safety system
let safetyInterval   = null;
let safetyCountdown  = null;
let safetyPopupTimer = null;
let spAutoTimer      = null;
let safetyActive     = true;
let safetySecondsLeft = 20 * 60;
const SAFETY_INTERVAL_SEC = 20 * 60; // 20 minutes
const POPUP_TIMEOUT_SEC   = 60;       // 60 seconds to respond

// ══════════════════════════════════════════
//  API HELPERS
// ══════════════════════════════════════════
async function api(path, method='GET', body=null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (APP.token) opts.headers['Authorization'] = 'Bearer ' + APP.token;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Legacy stubs — no longer used but kept so no reference errors
function saveApp() {}
function loadApp() {}
function getUsers() { return {}; }
function setUsers() {}

// ══════════════════════════════════════════
//  LOAD ALL USER DATA FROM SERVER
// ══════════════════════════════════════════
async function loadAppFromServer() {
  // Load profile + user info
  const profileData = await api('/profile');
  APP.user = profileData.user;
  const p = profileData.profile || {};
  APP.profile = {
    name:      APP.user.name,
    age:       p.age,
    gender:    p.gender,
    weight:    p.weight_kg,
    height:    p.height_cm,
    lifestyle: p.lifestyle,
    dtype:     p.dtype,
    year:      p.diagnosed_year,
    low:       p.target_low,
    high:      p.target_high,
    doc:       p.doctor_name,
    allergies: p.allergies,
    medsText:  p.meds_text,
    stepGoal:  p.step_goal || 8000,
    steps_today: p.steps_today || 0,
  };
  APP.steps = p.steps_today || 0;
  APP.onboarded = !!(p.age); // onboarded if profile has been filled

  // Load glucose readings
  const gData = await api('/glucose?limit=200');
  APP.readings = (gData.readings || []).map(r => ({
    id:    r.id,
    value: r.value,
    meal:  r.meal_context,
    note:  r.note,
    ts:    new Date(r.recorded_at).getTime(),
    label: r.classification || classify(r.value).label,
  })).reverse(); // oldest first for chart ordering

  // Load medications
  const mData = await api('/medications');
  APP.medications = (mData.medications || []).map(m => ({
    id:   m.id,
    name: m.name,
    dose: m.dose,
    time: m.time_of_day,
    freq: m.frequency,
    done: !!m.is_done,
  }));

  // Load emergency contacts
  const cData = await api('/contacts');
  APP.contacts = (cData.contacts || []).map(c => ({
    id:    c.id,
    name:  c.name,
    phone: c.phone,
    rel:   c.relationship,
  }));

  // Load safety log
  const sData = await api('/safety/log');
  APP.safetyLog = (sData.logs || []).map(l => ({
    type: l.log_type,
    msg:  l.message,
    ts:   new Date(l.logged_at).getTime(),
  }));
}

// ══════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════
function el(id) { return document.getElementById(id); }

function toast(msg, type) {
  const t = el('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.classList.remove('hidden');
  clearTimeout(window._tt);
  window._tt = setTimeout(() => t.classList.add('hidden'), 3500);
}

function showAlert(id, msg, type) {
  const a = el(id);
  if (!a) return;
  a.textContent = msg;
  a.className = 'inline-alert ' + type;
  a.classList.remove('hidden');
  setTimeout(() => a.classList.add('hidden'), 7000);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-IN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

function fmtSec(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

function classify(val) {
  if (val < 70)  return { label:'Hypoglycemia', cls:'hb-low',      riskCls:'critical' };
  if (val < 100) return { label:'Normal',       cls:'hb-normal',   riskCls:'low' };
  if (val < 126) return { label:'Pre-diabetic', cls:'hb-pre',      riskCls:'moderate' };
  if (val < 300) return { label:'Diabetic',     cls:'hb-diabetic', riskCls:'high' };
  return                 { label:'Critical',    cls:'hb-critical', riskCls:'critical' };
}

function healthScore() {
  if (!APP.readings.length) return null;
  const recent = APP.readings.slice(-10);
  const avg = recent.reduce((s,r)=>s+r.value,0) / recent.length;
  let score = 100;
  if (avg > 200)      score -= 40;
  else if (avg > 150) score -= 25;
  else if (avg > 126) score -= 15;
  else if (avg < 70)  score -= 20;
  score -= Math.min(APP.readings.filter(r=>r.value<70).length * 5, 20);
  if (APP.steps >= APP.profile.stepGoal)    score += 5;
  else if (APP.steps < 2000)                score -= 10;
  if (APP.medications.length)               score += 5;
  return Math.max(10, Math.min(100, Math.round(score)));
}

function calcRisk() {
  if (!APP.readings.length) return { level:'Unknown', pct:5, cls:'low' };
  const last = APP.readings.slice(-7);
  const avg  = last.reduce((s,r)=>s+r.value,0)/last.length;
  const hypos = APP.readings.filter(r=>r.value<70).length;
  if (avg > 250 || hypos > 3) return { level:'Critical', pct:92, cls:'critical' };
  if (avg > 180 || hypos > 1) return { level:'High',     pct:66, cls:'high' };
  if (avg > 130)               return { level:'Moderate', pct:40, cls:'moderate' };
  return { level:'Low', pct:16, cls:'low' };
}

function getFiltered(days) {
  const cut = Date.now() - days * 86400000;
  return APP.readings.filter(r => r.ts >= cut);
}

function inRangePct(list) {
  if (!list.length) return 0;
  return Math.round(list.filter(r=>r.value>=70&&r.value<=180).length/list.length*100);
}

function getLocation(cb) {
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => cb(`${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
      ()  => cb('Location unavailable (GPS denied)')
    );
  } else {
    cb('Location not supported');
  }
}

function addSafetyLog(type, msg) {
  APP.safetyLog.unshift({ type, msg, ts: Date.now() });
  if (APP.safetyLog.length > 50) APP.safetyLog.pop();
  renderSafetyLog();
  api('/safety/log', 'POST', { log_type: type, message: msg }).catch(()=>{});
}

// ══════════════════════════════════════════
//  PLAN ENGINE — v3.0
//  Factors: sugar level (live avg) + age + diabetes type + lifestyle
//  Returns a fully unique plan per user's actual health state
// ══════════════════════════════════════════

/* Returns live avg glucose of last 7 readings, or null if none */
function getLiveAvgGlucose() {
  if (!APP.readings.length) return null;
  const last = APP.readings.slice(-7);
  return Math.round(last.reduce((s,r)=>s+r.value,0)/last.length);
}

/* Sugar tier: 'hypo' | 'controlled' | 'mildHigh' | 'high' | 'veryHigh' | 'critical' */
function getSugarTier(avg) {
  if (avg === null)  return 'unknown';
  if (avg < 70)      return 'hypo';
  if (avg <= 110)    return 'controlled';
  if (avg <= 140)    return 'mildHigh';
  if (avg <= 180)    return 'high';
  if (avg <= 250)    return 'veryHigh';
  return 'critical';
}

/* Age bracket: 'young' | 'adult' | 'midage' | 'senior' | 'elderly' */
function getAgeBracket(age) {
  if (age < 20)  return 'young';
  if (age < 35)  return 'adult';
  if (age < 55)  return 'midage';
  if (age < 70)  return 'senior';
  return 'elderly';
}

function buildPlan() {
  const p         = APP.profile;
  const age       = parseInt(p.age)  || 40;
  const dtype     = p.dtype          || 'type2';
  const lifestyle = p.lifestyle      || 'sedentary';
  const gender    = p.gender         || 'male';
  const avgGluc   = getLiveAvgGlucose();
  const sugarTier = getSugarTier(avgGluc);
  const ageBracket= getAgeBracket(age);

  // ── Step goal: age + lifestyle ──────────
  let stepGoal = 8000;
  if (age >= 70)              stepGoal = 4000;
  else if (age >= 65)         stepGoal = 5000;
  else if (lifestyle==='sedentary') stepGoal = 6000;
  else if (lifestyle==='active')    stepGoal = 10000;
  else if (lifestyle==='moderate')  stepGoal = 9000;
  APP.profile.stepGoal = stepGoal;

  // ── DIET DATABASE ───────────────────────
  // Each entry = { breakfast[], lunch[], dinner[], snacks[], avoid[], note, portionNote }
  // Keyed by: `${dtype}_${sugarTier}_${ageBracket}`
  // Falls back progressively: dtype_sugarTier → dtype → type2

  const DIETS = {

    // ╔══════════════════════════════╗
    // ║         TYPE 1               ║
    // ╚══════════════════════════════╝
    type1_hypo_young: {
      breakfast: ['Banana (1 medium) with peanut butter', 'Whole grain toast (2 slices)', 'Full-fat milk (1 glass)', 'Scrambled eggs (2)'],
      lunch:     ['White rice (1 cup) — easier to digest during hypo', 'Grilled chicken (100g)', 'Stir-fried vegetables', 'Curd (unsweetened)'],
      dinner:    ['Brown rice (small)', 'Dal (lentils)', 'Vegetable curry', 'Roti (1)'],
      snacks:    ['Glucose tablets after exercise', 'Fruit juice (small, unsweetened — only for hypo correction)', 'Dates (2–3)', 'Milk (1 glass)'],
      avoid:     ['Skipping meals', 'Excessive fiber during hypo episode', 'Alcohol', 'Over-fasting'],
      note:      '⚠️ Hypo detected. Your plan prioritises quick glucose recovery. Always carry glucose tablets.',
      portionNote:'Your sugar is LOW. Eat more frequent small meals with moderate carbs to stabilise.',
    },
    type1_controlled_young: {
      breakfast: ['Steel-cut oats with cinnamon & chia seeds', 'Boiled eggs (2)', 'Multigrain toast (1 slice)', 'Green tea (no sugar)'],
      lunch:     ['Brown rice (½ cup)', 'Grilled fish (100g)', 'Steamed broccoli & carrots', 'Cucumber salad', 'Curd'],
      dinner:    ['Whole wheat rotis (2)', 'Moong dal soup', 'Sabzi (spinach/methi)', 'Raita (low-fat)'],
      snacks:    ['Almonds (8)', 'Apple or guava (1 small)', 'Roasted chana (1 handful)', 'Buttermilk (plain)'],
      avoid:     ['White rice (large)', 'Sugary drinks', 'Maida products', 'Deep fried snacks', 'Packaged sweets'],
      note:      '✅ Your glucose is well-controlled! This balanced plan keeps you in range.',
      portionNote:'Maintain consistent meal timing. Carb-counting helps manage insulin doses effectively.',
    },
    type1_mildHigh_young: {
      breakfast: ['Oats porridge (no sugar, add cinnamon)', 'Egg whites (3)', 'Small portion of berries', 'Herbal green tea'],
      lunch:     ['Small brown rice or millets', 'Grilled chicken or fish (80g)', 'Large green salad (no dressing)', 'Dal (thin)'],
      dinner:    ['2 jowar rotis (smaller)', 'Sabzi (bitter gourd/karela recommended)', 'Clear soup', 'Curd (small)'],
      snacks:    ['Walnuts (5–6)', 'Guava (1 small)', 'Roasted pumpkin seeds', 'Cucumber sticks'],
      avoid:     ['White rice', 'Fruit juice', 'Desserts', 'Bread (white)', 'High-GI fruits (mango, banana — limit)'],
      note:      '⚠️ Glucose is slightly elevated. Reducing carb portions and increasing vegetables is key.',
      portionNote:'Reduce rice/roti portions by 25%. Increase leafy greens and protein in every meal.',
    },
    type1_high_adult: {
      breakfast: ['Vegetable omelette (3 eggs, no yolk)', 'Only 1 slice multigrain toast', 'Bitter gourd (karela) juice (small)', 'Herbal tea'],
      lunch:     ['Millet khichdi (small portion)', 'Sprout salad (large)', 'Stir-fried bitter vegetables', 'Thin dal', 'No rice today'],
      dinner:    ['1 jowar roti', 'Palak paneer (low-fat)', 'Moong dal soup', 'Raw salad (large)'],
      snacks:    ['Fenugreek water (morning)', 'A handful of nuts only', 'Buttermilk (no salt)', 'No fruit today'],
      avoid:     ['All forms of sugar', 'Rice', 'White flour', 'Potatoes', 'Corn', 'Sweet fruits', 'Alcohol', 'Fruit juice'],
      note:      '🔴 High glucose detected. Strict low-carb, high-protein plan activated. Consult your doctor.',
      portionNote:'Carbs cut to minimum. Every meal must have protein + fiber to slow glucose absorption.',
    },
    type1_veryHigh_midage: {
      breakfast: ['Only egg whites (4) with spinach stir-fry', 'Fenugreek water (methi water)', 'Green tea (no sugar)', 'No grains today'],
      lunch:     ['Steamed fish or tofu (150g)', 'Large salad of raw veggies', 'Thin lentil soup (1 small bowl)', 'Bitter gourd stir-fry'],
      dinner:    ['1 small jowar roti', 'Sautéed leafy greens', 'Moong dal (thin, small)', 'Cucumber & onion salad'],
      snacks:    ['Fenugreek seeds soaked in water', 'Amla (Indian gooseberry, 2)', 'A few almonds only', 'Plain water'],
      avoid:     ['ALL grains except 1 small roti', 'ALL fruits except amla/guava', 'Dairy (full-fat)', 'Potatoes, corn, peas', 'Any sweetener'],
      note:      '🚨 Very high glucose! Emergency low-carb plan. Immediate medication review needed.',
      portionNote:'Maximum protein, minimum carbs. Monitor every 4 hours. Consult doctor today.',
    },
    type1_critical_senior: {
      breakfast: ['Only egg whites (3) boiled', 'Methi (fenugreek) water — 1 glass', 'No grains at all', 'No fruit'],
      lunch:     ['Steamed fish/chicken (100g)', 'Steamed non-starchy vegetables only', 'Thin clear soup', 'No rice, no roti'],
      dinner:    ['Grilled paneer (50g)', 'Steamed bitter vegetables', 'Thin lentil broth', 'Salad (only cucumber, tomato)'],
      snacks:    ['Plain water only between meals', 'Methi water or amla juice (tiny)', 'Doctor-approved snacks only'],
      avoid:     ['Everything with sugar or refined carbs', 'All grains', 'All fruits', 'Dairy except buttermilk', 'Salt excess'],
      note:      '🚨 CRITICAL glucose. This is a medical emergency diet. Please contact your doctor immediately.',
      portionNote:'Medical dietary supervision required. Do not follow this plan without doctor consultation.',
    },

    // ╔══════════════════════════════╗
    // ║         TYPE 2               ║
    // ╚══════════════════════════════╝
    type2_controlled_young: {
      breakfast: ['Vegetable dalia (broken wheat) with flaxseeds', 'Boiled egg whites (3)', 'Black coffee or green tea (no sugar)', 'A few walnuts'],
      lunch:     ['Small brown rice or millet rice', 'Rajma or chana (1 cup)', 'Mixed vegetable curry (no potato)', 'Plain curd', 'Salad'],
      dinner:    ['2 whole wheat rotis', 'Dal palak', 'Sabzi (low starch)', 'Buttermilk'],
      snacks:    ['Roasted chana', 'Guava or papaya (small)', 'Sprout salad', 'Pumpkin seeds (handful)'],
      avoid:     ['White rice', 'Sugary drinks', 'Packaged biscuits', 'Maida items', 'Fried foods', 'Sweet lassi'],
      note:      '✅ Glucose well-controlled. This balanced plan maintains your great progress.',
      portionNote:'Plate formula: 50% vegetables, 25% protein, 25% complex carbs. Stick to it every meal.',
    },
    type2_controlled_midage: {
      breakfast: ['Oats with chia & flaxseeds', 'Boiled egg (1 whole + 1 white)', 'Herbal tea', 'Soaked almonds (6)'],
      lunch:     ['½ cup brown rice + 1 jowar roti', 'Grilled chicken or dal', 'Stir-fried vegetables (no potato)', 'Curd (low-fat)'],
      dinner:    ['2 jowar/bajra rotis', 'Vegetable sabzi', 'Thin dal', 'Salad', 'Buttermilk'],
      snacks:    ['Nuts (small handful)', 'Low-sugar fruits', 'Sprouts (1 cup)', 'Coconut water (unsweetened)'],
      avoid:     ['White rice (large portion)', 'Sweets', 'Fried snacks', 'Processed foods', 'High-fat dairy', 'Alcohol'],
      note:      '✅ Good glucose control. Consistency with portion size is your key tool now.',
      portionNote:'Reduce portions by 10% from last month. More fibre, more water, less oil.',
    },
    type2_controlled_senior: {
      breakfast: ['Soft oats porridge (easy to eat)', 'Boiled egg (1)', 'Herbal tea (no sugar)', 'Soaked almonds (4)'],
      lunch:     ['Small portion soft-cooked millet or brown rice', 'Dal (well-cooked)', 'Soft sabzi', 'Curd'],
      dinner:    ['1–2 soft jowar rotis', 'Light dal soup', 'Stewed vegetables', 'Buttermilk'],
      snacks:    ['Banana (½, only if glucose is well controlled)', 'Boiled chana', 'Roasted makhana', 'Warm milk (low-fat)'],
      avoid:     ['Hard-to-digest foods', 'Excess salt', 'Fried items', 'Packaged foods', 'Sugar', 'Carbonated drinks'],
      note:      '✅ Glucose controlled. Senior plan prioritises easy digestion and bone health.',
      portionNote:'Eat 5–6 small meals. Avoid large portions. Stay hydrated — seniors often underdrink water.',
    },
    type2_mildHigh_adult: {
      breakfast: ['Moong dal chilla (2, no oil)', 'Green tea (no sugar)', 'Amla (1) or Guava (small)', 'Walnuts (4)'],
      lunch:     ['1 jowar roti only (no rice)', 'Dal + stir-fried green vegetables', 'Large salad (cucumber, tomato, onion)', 'Thin curd'],
      dinner:    ['1 bajra roti', 'Bitter gourd sabzi', 'Moong soup', 'Salad'],
      snacks:    ['Fenugreek water (morning and evening)', 'Roasted chana', 'Cucumber sticks', 'A few almonds'],
      avoid:     ['White rice', 'All sugar', 'Wheat bread', 'Potato', 'Sweet fruits', 'Packaged juices', 'Alcohol'],
      note:      '⚠️ Glucose slightly high. Reducing carbs and increasing bitter foods helps lower levels naturally.',
      portionNote:'No rice for 1 week. Replace with millets. Eat bitter vegetables daily (karela, methi, neem leaf water).',
    },
    type2_high_midage: {
      breakfast: ['Only moong dal chilla (1) or vegetable omelette', 'Methi water or karela juice (tiny)', 'Green tea', 'No grains'],
      lunch:     ['Sprout salad (large)', 'Grilled chicken or paneer (small portion)', 'Stir-fried non-starchy vegetables', 'Thin dal only'],
      dinner:    ['1 small bajra roti', 'Bitter vegetable sabzi', 'Clear soup', 'Curd (small)'],
      snacks:    ['Soaked fenugreek seeds', 'A few nuts only', 'Buttermilk (plain)', 'Amla (1–2)'],
      avoid:     ['Rice (all types)', 'All flour-based items', 'All sweet fruits', 'Dairy (full-fat)', 'Potatoes', 'All packaged snacks'],
      note:      '🔴 High glucose. Aggressive carb reduction and increased protein is your plan.',
      portionNote:'No grains except 1 small millet roti. Every meal must start with a salad to slow glucose spike.',
    },
    type2_veryHigh_senior: {
      breakfast: ['Boiled egg whites (2)', 'Methi water', 'Steamed vegetables (small)', 'No grains, no fruit'],
      lunch:     ['Steamed fish or tofu (100g)', 'Large vegetable salad', 'Thin lentil broth', 'Bitter gourd stir-fry'],
      dinner:    ['1 tiny bajra roti (or skip)', 'Sabzi (only leafy greens)', 'Moong dal broth (thin)', 'Cucumber salad'],
      snacks:    ['Plain water or methi water only', 'Doctor-approved snacks', 'Amla (1)', 'Buttermilk (plain, small)'],
      avoid:     ['All grains', 'All fruits except amla/guava', 'All dairy except buttermilk', 'All sugar', 'All packaged foods'],
      note:      '🚨 Very high glucose. Please consult your doctor. This is a strict medical diet.',
      portionNote:'Supervised eating required. Monitor glucose every 3 hours.',
    },
    type2_critical_elderly: {
      breakfast: ['Only clear vegetable soup', 'Methi water (1 glass)', 'Steamed leafy greens (tiny)', 'Doctor-approved supplements only'],
      lunch:     ['Steamed fish (80g) if tolerable', 'Steamed non-starchy vegetables', 'Thin dal broth', 'No grains at all'],
      dinner:    ['Light vegetable broth', 'Steamed greens', 'Buttermilk (50ml)', 'Doctor-recommended food only'],
      snacks:    ['Plain warm water only', 'Amla juice (tiny, doctor approved)', 'Nothing else without medical advice'],
      avoid:     ['Everything not prescribed by doctor', 'All grains', 'All fruits', 'All dairy', 'All sugar forms'],
      note:      '🚨 CRITICAL glucose — MEDICAL EMERGENCY. Contact your doctor immediately. Do not self-manage.',
      portionNote:'Hospital consultation urgently needed. This plan is a temporary emergency guide only.',
    },

    // ── GENERAL FALLBACKS (cover all missing combos) ──
    type2_controlled_adult: {
      breakfast: ['Oats with chia & flaxseeds', 'Boiled egg (1 whole + 1 white)', 'Herbal tea', 'Soaked almonds (6)'],
      lunch:     ['½ cup brown rice + 1 jowar roti', 'Grilled chicken or dal', 'Stir-fried vegetables (no potato)', 'Curd (low-fat)'],
      dinner:    ['2 jowar/bajra rotis', 'Vegetable sabzi', 'Thin dal', 'Salad', 'Buttermilk'],
      snacks:    ['Nuts (small handful)', 'Low-sugar fruits', 'Sprouts (1 cup)', 'Coconut water (unsweetened)'],
      avoid:     ['White rice (large portion)', 'Sweets', 'Fried snacks', 'Processed foods', 'High-fat dairy', 'Alcohol'],
      note:      '✅ Good glucose control. Consistency with portion size is your key tool.',
      portionNote:'Reduce portions by 10%. More fibre, more water, less oil.',
    },
    type1_controlled_adult: {
      breakfast: ['Steel-cut oats with cinnamon & chia seeds', 'Boiled eggs (2)', 'Multigrain toast (1 slice)', 'Green tea (no sugar)'],
      lunch:     ['Brown rice (½ cup)', 'Grilled fish (100g)', 'Steamed broccoli & carrots', 'Cucumber salad', 'Curd'],
      dinner:    ['Whole wheat rotis (2)', 'Moong dal soup', 'Sabzi (spinach/methi)', 'Raita (low-fat)'],
      snacks:    ['Almonds (8)', 'Apple or guava (1 small)', 'Roasted chana (1 handful)', 'Buttermilk (plain)'],
      avoid:     ['White rice (large)', 'Sugary drinks', 'Maida products', 'Deep fried snacks', 'Packaged sweets'],
      note:      '✅ Glucose well-controlled! This balanced plan keeps you in range.',
      portionNote:'Consistent meal timing helps manage insulin doses effectively.',
    },
    type1_controlled_midage: {
      breakfast: ['Oats porridge (no sugar, add cinnamon)', 'Boiled eggs (2)', 'Black coffee or green tea (no sugar)', 'Walnuts (4)'],
      lunch:     ['Small brown rice or millet', 'Grilled chicken or fish (80g)', 'Mixed vegetable curry (no potato)', 'Plain curd', 'Salad'],
      dinner:    ['2 jowar rotis', 'Dal palak', 'Sabzi (low starch)', 'Buttermilk'],
      snacks:    ['Roasted chana', 'Guava or papaya (small)', 'Pumpkin seeds (handful)', 'Coconut water'],
      avoid:     ['White rice', 'Sugary drinks', 'Packaged biscuits', 'Maida items', 'Fried foods', 'Sweet lassi'],
      note:      '✅ Glucose controlled. Keep portions consistent and monitor after meals.',
      portionNote:'At midage, metabolism slows. Portion control now matters more. Low-impact exercise daily.',
    },
    type1_controlled_senior: {
      breakfast: ['Soft oats porridge (easy to eat)', 'Boiled egg (1)', 'Herbal tea (no sugar)', 'Soaked almonds (4)'],
      lunch:     ['Small portion soft-cooked millet or brown rice', 'Dal (well-cooked)', 'Soft sabzi', 'Curd'],
      dinner:    ['1–2 soft jowar rotis', 'Light dal soup', 'Stewed vegetables', 'Buttermilk'],
      snacks:    ['Banana (½, only if glucose is well controlled)', 'Boiled chana', 'Roasted makhana', 'Warm milk (low-fat)'],
      avoid:     ['Hard-to-digest foods', 'Excess salt', 'Fried items', 'Packaged foods', 'Sugar', 'Carbonated drinks'],
      note:      '✅ Good control. Senior plan prioritises easy digestion and bone health.',
      portionNote:'Eat 5–6 small meals. Avoid large portions. Stay hydrated.',
    },
    type2_hypo_adult: {
      breakfast: ['Banana (1 medium) with peanut butter', 'Whole grain toast (2 slices)', 'Full-fat milk (1 glass)', 'Scrambled eggs (2)'],
      lunch:     ['White rice (1 cup) — easier to digest during hypo', 'Grilled chicken (100g)', 'Stir-fried vegetables', 'Curd (unsweetened)'],
      dinner:    ['Brown rice (small)', 'Dal (lentils)', 'Vegetable curry', 'Roti (1)'],
      snacks:    ['Glucose tablets after exercise', 'Fruit juice (small, unsweetened — only for hypo correction)', 'Dates (2–3)', 'Milk (1 glass)'],
      avoid:     ['Skipping meals', 'Excessive fiber during hypo episode', 'Alcohol', 'Over-fasting'],
      note:      '⚠️ Hypo detected. Plan prioritises quick glucose recovery. Always carry glucose tablets.',
      portionNote:'Your sugar is LOW. Eat more frequent small meals with moderate carbs to stabilise.',
    },
    prediabetes_controlled_adult: {
      breakfast: ['Vegetable omelette (2 eggs)', 'Whole grain toast (1)', 'Fresh lime water (no sugar)', 'Mixed seeds (1 tsp)'],
      lunch:     ['Millet khichdi (½ cup)', 'Rajma or chana (1 cup)', 'Mixed vegetables', 'Plain yogurt', 'Salad'],
      dinner:    ['2 whole wheat rotis', 'Paneer or tofu sabzi (small)', 'Clear vegetable soup'],
      snacks:    ['Walnuts & almonds (small mix)', 'Guava or berries (small)', 'Roasted makhana', 'Coconut water (small)'],
      avoid:     ['White rice (large)', 'Sugar in tea/coffee', 'Packaged juice', 'Sweets', 'Pizza, burger', 'Chips'],
      note:      '✅ Glucose in range! You have a REAL chance to reverse pre-diabetes. Stay on this plan.',
      portionNote:'You are close to reversing pre-diabetes. Keep carbs moderate, exercise daily.',
    },
    prediabetes_controlled_midage: {
      breakfast: ['Moong dal chilla (2, no oil)', 'Green tea (no sugar)', 'Walnuts (4)', 'Soaked almonds (4)'],
      lunch:     ['1 jowar roti', 'Dal + stir-fried vegetables', 'Large salad', 'Thin curd'],
      dinner:    ['1 bajra roti', 'Sabzi (low-starch)', 'Moong soup', 'Salad'],
      snacks:    ['Fenugreek water', 'Roasted chana', 'Cucumber sticks', 'A few almonds'],
      avoid:     ['White rice', 'All sugar', 'Wheat bread', 'Potato', 'Sweet fruits', 'Packaged juices'],
      note:      '✅ Glucose controlled. Consistency at midage prevents progression to Type 2.',
      portionNote:'At midage, strict portion control plus 30 min daily walk is the best reversal strategy.',
    },
    prediabetes_controlled_senior: {
      breakfast: ['Soft oats with chia seeds', 'Boiled egg (1)', 'Herbal tea (no sugar)', 'Soaked almonds (4)'],
      lunch:     ['½ cup soft-cooked millet', 'Dal (well-cooked, thin)', 'Soft sabzi (no potato)', 'Curd'],
      dinner:    ['1–2 soft jowar rotis', 'Vegetable soup', 'Stewed greens', 'Buttermilk'],
      snacks:    ['Boiled chana (small)', 'Roasted makhana', 'Warm low-fat milk', 'Guava (small)'],
      avoid:     ['Hard-to-chew foods', 'Excess salt', 'Fried foods', 'Sugar', 'Carbonated drinks'],
      note:      '✅ Good control. Focus on easy digestion and regular light activity.',
      portionNote:'5–6 small meals. Never skip. Gentle walking daily prevents progression.',
    },
    gestational_controlled_young: {
      breakfast: ['Whole grain cereal with low-fat milk', 'Scrambled eggs (2)', 'Small apple', 'Water'],
      lunch:     ['Small brown rice (½ cup)', 'Dal (well-cooked)', 'Steamed vegetables', 'Curd (low-fat)', 'Salad'],
      dinner:    ['2 soft rotis', 'Palak paneer (low-fat)', 'Vegetable soup', 'Salad'],
      snacks:    ['Nuts & seeds (small handful)', 'Low-GI fruit (guava, pear)', 'Whole grain crackers (2)', 'Low-fat cheese (small)'],
      avoid:     ['Sugary drinks', 'Processed foods', 'Raw/undercooked', 'High-mercury fish', 'Alcohol', 'Excess caffeine'],
      note:      '✅ Good glucose control during pregnancy. Baby and mother are getting balanced nutrition.',
      portionNote:'Eat every 2–3 hours in small portions. Never skip meals. Folic acid and iron are essential.',
    },

    // ╔══════════════════════════════╗
    // ║       PRE-DIABETES           ║
    // ╚══════════════════════════════╝
    prediabetes_controlled_young: {
      breakfast: ['Vegetable omelette (2 eggs)', 'Whole grain toast (1)', 'Fresh lime water (no sugar)', 'Mixed seeds (1 tsp)'],
      lunch:     ['Millet khichdi (½ cup)', 'Rajma or chana (1 cup)', 'Mixed vegetables', 'Plain yogurt', 'Salad'],
      dinner:    ['2 whole wheat rotis', 'Paneer or tofu sabzi (small)', 'Clear vegetable soup'],
      snacks:    ['Walnuts & almonds (small mix)', 'Guava or berries (small)', 'Roasted makhana', 'Coconut water (small)'],
      avoid:     ['White rice (large)', 'Sugar in tea/coffee', 'Packaged juice', 'Sweets', 'Pizza, burger', 'Chips'],
      note:      '✅ Glucose in range! You have a REAL chance to reverse pre-diabetes. Stay on this plan.',
      portionNote:'You are close to reversing pre-diabetes. Keep carbs moderate, exercise daily, lose 5% body weight.',
    },
    prediabetes_mildHigh_adult: {
      breakfast: ['Moong dal dosa (1, no oil)', 'Vegetable stir-fry', 'Green tea (no sugar)', 'Walnuts (4)'],
      lunch:     ['1 jowar roti (no rice)', 'Large salad', 'Grilled chicken or chana', 'Thin curd', 'Bitter gourd sabzi'],
      dinner:    ['1 bajra roti', 'Methi sabzi', 'Moong soup', 'Salad'],
      snacks:    ['Fenugreek water', 'Guava (1 small)', 'Roasted chana', 'Cucumber'],
      avoid:     ['White rice', 'All sugars', 'Maida', 'Potato', 'Sweet fruits', 'Packaged foods'],
      note:      '⚠️ Glucose slightly elevated. Strict carb control now prevents full Type 2 diabetes.',
      portionNote:'URGENT: Reduce carbs by 40% this week. You can still reverse this with diet + exercise.',
    },
    prediabetes_high_midage: {
      breakfast: ['Only egg whites (3)', 'Karela juice (small)', 'Green tea', 'No bread/toast'],
      lunch:     ['Sprout salad (large)', 'Grilled fish or paneer', 'Stir-fried bitter vegetables', 'No grains'],
      dinner:    ['1 tiny bajra roti', 'Leafy green sabzi', 'Thin dal', 'Salad'],
      snacks:    ['Soaked fenugreek seeds', 'Nuts only', 'Buttermilk', 'Amla (1)'],
      avoid:     ['Rice', 'All flour items', 'All sweet fruits', 'Sugar in any form', 'Fried foods', 'Processed snacks'],
      note:      '🔴 High glucose in pre-diabetic range — action required NOW to prevent Type 2 diabetes.',
      portionNote:'Immediate lifestyle change needed. No grains this week except 1 small millet roti per day.',
    },

    // ╔══════════════════════════════╗
    // ║       GESTATIONAL            ║
    // ╚══════════════════════════════╝
    gestational_controlled_adult: {
      breakfast: ['Whole grain cereal with low-fat milk', 'Scrambled eggs (2)', 'Small apple', 'Water'],
      lunch:     ['Small brown rice (½ cup)', 'Dal (well-cooked)', 'Steamed vegetables', 'Curd (low-fat)', 'Salad'],
      dinner:    ['2 soft rotis', 'Palak paneer (low-fat)', 'Vegetable soup', 'Salad'],
      snacks:    ['Nuts & seeds (small handful)', 'Low-GI fruit (guava, pear)', 'Whole grain crackers (2)', 'Low-fat cheese (small)'],
      avoid:     ['Sugary drinks', 'Processed foods', 'Raw/undercooked', 'High-mercury fish', 'Alcohol', 'Excess caffeine'],
      note:      '✅ Good glucose control during pregnancy. Baby and mother are getting balanced nutrition.',
      portionNote:'Eat every 2–3 hours in small portions. Never skip meals. Folic acid and iron are essential.',
    },
    gestational_mildHigh_adult: {
      breakfast: ['Vegetable omelette (2 eggs)', 'Only 1 slice multigrain toast', 'Herbal tea (no sugar)', 'Soaked almonds (4)'],
      lunch:     ['1 small roti (no rice)', 'Dal', 'Stir-fried non-starchy vegetables', 'Curd (thin)'],
      dinner:    ['1–2 soft rotis', 'Sabzi (bitter or leafy greens)', 'Clear soup', 'Salad'],
      snacks:    ['Roasted chana', 'Guava (small)', 'Nuts (small)', 'Coconut water (small)'],
      avoid:     ['Rice', 'Sweet fruits', 'Sugary drinks', 'Maida', 'Potato-heavy dishes', 'Sweets'],
      note:      '⚠️ Gestational glucose slightly high. Controlled diet protects your baby. Consult OB-GYN.',
      portionNote:'Reduce rice & roti. Increase protein and green vegetables. Check glucose after every meal.',
    },
    gestational_high_adult: {
      breakfast: ['Only egg whites (2) + vegetable stir-fry', 'Methi water', 'Herbal tea', 'No grains'],
      lunch:     ['1 small roti only', 'Large salad', 'Grilled lean protein', 'Thin dal', 'Bitter vegetables'],
      dinner:    ['1 small roti', 'Sabzi (leafy greens)', 'Clear soup', 'Curd (small)'],
      snacks:    ['Nuts only', 'Buttermilk', 'Cucumber sticks', 'Doctor-approved snack'],
      avoid:     ['Rice', 'All sugars', 'All sweet fruits', 'Fried foods', 'Excess sodium'],
      note:      '🔴 High gestational glucose — Immediate OB-GYN consultation needed. Baby at risk.',
      portionNote:'Medical supervision required. Every meal needs to be carefully measured and tracked.',
    },
  };

  // ── EXERCISE DATABASE ────────────────────
  const EXERCISES = {
    type1_sedentary:   [
      { icon:'🚶', name:'Brisk Walking',       detail:'20 min, twice daily. Always check glucose before starting.', badge:'Core Exercise' },
      { icon:'🧘', name:'Chair Yoga',           detail:'15 min morning. Reduces cortisol, lowers glucose gently.', badge:'Daily' },
      { icon:'🏊', name:'Swimming (gentle)',    detail:'20 min, 3x/week. Low-impact, ideal for Type 1.', badge:'3x Week' },
      { icon:'🤸', name:'Light Stretching',     detail:'10 min before bed. Improves insulin sensitivity overnight.', badge:'Nightly' },
    ],
    type1_light: [
      { icon:'🚶', name:'Brisk Walking',        detail:'30 min daily. Carry glucose tablets always.', badge:'Daily' },
      { icon:'🧘', name:'Yoga',                 detail:'25 min stretching & breathing. Lowers stress hormones.', badge:'Daily' },
      { icon:'🚴', name:'Cycling (moderate)',   detail:'20 min, 3x/week. Monitor glucose before/after.', badge:'3x Week' },
      { icon:'💪', name:'Light Resistance Bands',detail:'10 min, 3x/week. Builds muscle glucose uptake.', badge:'3x Week' },
    ],
    type1_moderate: [
      { icon:'🏃', name:'Jogging',              detail:'25 min, 4x/week. Check glucose before — avoid if <100.', badge:'4x Week' },
      { icon:'💪', name:'Light Weight Training',detail:'3 sets × 12 reps, 3x/week. Improves insulin sensitivity.', badge:'3x Week' },
      { icon:'🧘', name:'Yoga + Meditation',    detail:'20 min daily. Essential stress management for Type 1.', badge:'Daily' },
      { icon:'🏊', name:'Swimming',             detail:'30 min, 2x/week. Excellent full-body glucose burn.', badge:'2x Week' },
    ],
    type1_active: [
      { icon:'🏃', name:'Running',              detail:'30 min, 4x/week. Always carry fast-acting sugar.', badge:'4x Week' },
      { icon:'💪', name:'Weight Training',      detail:'45 min, 3x/week. Monitor glucose pre/post every session.', badge:'3x Week' },
      { icon:'🧘', name:'Recovery Yoga',        detail:'20 min daily. Non-negotiable for Type 1 active patients.', badge:'Daily' },
      { icon:'🚴', name:'Cycling',              detail:'30 min, 2x/week cross-training.', badge:'2x Week' },
    ],
    type2_sedentary: [
      { icon:'🚶', name:'Walking (start slow)',  detail:'Begin at 10 min/day. Add 5 min each week until 30 min.', badge:'Start Here' },
      { icon:'🪑', name:'Chair Exercises',       detail:'Seated leg raises, arm circles — 15 min daily.', badge:'Daily' },
      { icon:'🧘', name:'Pranayama Breathing',  detail:'10 min kapalbhati — clinically proven to lower sugar.', badge:'Morning' },
      { icon:'🤸', name:'Light Stretching',     detail:'10 min daily. Improves circulation and insulin action.', badge:'Daily' },
    ],
    type2_light: [
      { icon:'🚶', name:'Brisk Walking',         detail:'30 min daily — single most effective Type 2 exercise.', badge:'Core — Daily' },
      { icon:'🏊', name:'Swimming',              detail:'30 min, 3x/week. Burns calories without joint stress.', badge:'3x Week' },
      { icon:'🧘', name:'Yoga',                  detail:'25 min daily. Reduces insulin resistance significantly.', badge:'Daily' },
      { icon:'💪', name:'Resistance Bands',      detail:'15 min, 3x/week. Muscle is your best glucose regulator.', badge:'3x Week' },
    ],
    type2_moderate: [
      { icon:'🏃', name:'Jogging',               detail:'25 min, 4x/week. Significantly lowers HbA1c levels.', badge:'4x Week' },
      { icon:'💪', name:'Resistance Training',   detail:'30 min weights, 3x/week. Best long-term glucose control.', badge:'3x Week' },
      { icon:'🚴', name:'Cycling',               detail:'20 min, 3x/week. Great cardiovascular workout.', badge:'3x Week' },
      { icon:'🧘', name:'Yoga',                  detail:'20 min daily morning routine for stress management.', badge:'Daily' },
    ],
    type2_active: [
      { icon:'🏃', name:'Running',               detail:'30–40 min, 5x/week for maximum glucose reduction.', badge:'5x Week' },
      { icon:'💪', name:'Weight Training',        detail:'45 min, 4x/week. Higher muscle mass = better glucose use.', badge:'4x Week' },
      { icon:'🧘', name:'HIIT (moderate)',        detail:'20 min intervals, 2x/week. Monitor glucose closely.', badge:'2x Week' },
      { icon:'🚴', name:'Cycling',               detail:'30 min, 2x/week cross-training.', badge:'2x Week' },
    ],
    prediabetes_sedentary: [
      { icon:'🚶', name:'Walking — 30 min',       detail:'Daily walking ALONE can reverse pre-diabetes. Non-negotiable.', badge:'CRITICAL — Daily' },
      { icon:'🧘', name:'Morning Yoga',           detail:'15 min reduces fasting glucose within 2 weeks.', badge:'Daily' },
      { icon:'🪜', name:'Stair Climbing',         detail:'10 min daily — replace elevator. Easy calorie burn.', badge:'Daily' },
      { icon:'🤸', name:'Stretching',             detail:'10 min before bed. Improves overnight insulin sensitivity.', badge:'Nightly' },
    ],
    prediabetes_light: [
      { icon:'🚶', name:'Brisk Walking — 45 min', detail:'Proven to prevent Type 2 in clinical trials. Walk fast.', badge:'Core — Daily' },
      { icon:'🏊', name:'Swimming',               detail:'30 min, 3x/week. Full body without joint strain.', badge:'3x Week' },
      { icon:'💪', name:'Light Strength',         detail:'20 min, 3x/week. Muscle burns more glucose at rest.', badge:'3x Week' },
      { icon:'🧘', name:'Yoga',                   detail:'20 min daily for insulin sensitivity.', badge:'Daily' },
    ],
    prediabetes_moderate: [
      { icon:'🏃', name:'Running / Fast Walk',    detail:'30 min, 4x/week. Best exercise for pre-diabetes reversal.', badge:'4x Week' },
      { icon:'💪', name:'Weight Training',        detail:'30 min, 3x/week. Build muscle to absorb more glucose.', badge:'3x Week' },
      { icon:'🧘', name:'Yoga',                   detail:'20 min daily. Stress is a hidden cause of high glucose.', badge:'Daily' },
      { icon:'🚴', name:'Cycling',                detail:'20 min, 2x/week.', badge:'2x Week' },
    ],
    prediabetes_active: [
      { icon:'🏃', name:'Running / HIIT',         detail:'40 min, 5x/week. Maximum pre-diabetes reversal potential.', badge:'5x Week' },
      { icon:'💪', name:'Strength Training',      detail:'45 min, 4x/week. Build maximum insulin-sensitive muscle.', badge:'4x Week' },
      { icon:'🧘', name:'Meditation',             detail:'15 min daily. Cortisol directly raises blood sugar.', badge:'Daily' },
      { icon:'🚴', name:'Cycling',                detail:'30 min, 2x/week cross-training.', badge:'2x Week' },
    ],
    gestational_sedentary: [
      { icon:'🚶', name:'Gentle Walking',         detail:'20 min, twice daily. Safe in all pregnancy trimesters.', badge:'Safe — Daily' },
      { icon:'🧘', name:'Prenatal Yoga',          detail:'20 min with certified prenatal instructor.', badge:'Daily' },
      { icon:'🏊', name:'Water Aerobics',         detail:'25 min, 3x/week. Takes pressure off joints.', badge:'3x Week' },
    ],
    gestational_light: [
      { icon:'🚶', name:'Brisk Walking',          detail:'30 min daily. Monitor glucose 30 min after.', badge:'Daily' },
      { icon:'🧘', name:'Prenatal Yoga',          detail:'30 min, 4x/week with prenatal instructor.', badge:'4x Week' },
      { icon:'💪', name:'Light Resistance',       detail:'15 min, 2x/week. Pregnancy-approved exercises only.', badge:'2x Week' },
    ],
    gestational_moderate: [
      { icon:'🚶', name:'Walking',                detail:'30 min daily. Adjust intensity as pregnancy progresses.', badge:'Daily' },
      { icon:'🧘', name:'Prenatal Yoga',          detail:'30 min, 4x/week.', badge:'4x Week' },
      { icon:'🏊', name:'Swimming',               detail:'25 min, 2x/week. Excellent in third trimester.', badge:'2x Week' },
    ],
    gestational_active: [
      { icon:'🚶', name:'Walking',                detail:'45 min daily. Reduce intensity in 3rd trimester.', badge:'Daily' },
      { icon:'🧘', name:'Prenatal Yoga',          detail:'30 min daily.', badge:'Daily' },
      { icon:'🏊', name:'Swimming',               detail:'30 min, 3x/week.', badge:'3x Week' },
    ],
  };

  // ── LOOKUP with smart fallback ───────────
  function findDiet(dtype, sugarTier, ageBracket) {
    // Try most specific first, then broaden progressively
    const ageFallbacks = [ageBracket, 'adult', 'midage', 'young', 'senior'];
    const tierFallbacks = [sugarTier, 'controlled', 'mildHigh', 'high'];
    const typeFallbacks = [dtype, 'type2'];
    for (const t of typeFallbacks) {
      for (const tier of tierFallbacks) {
        for (const ag of ageFallbacks) {
          const k = `${t}_${tier}_${ag}`;
          if (DIETS[k]) return DIETS[k];
        }
      }
    }
    // Absolute last resort — this key always exists
    return DIETS['type2_controlled_midage'];
  }

  function findExercise(dtype, lifestyle) {
    const lifeFallbacks = [lifestyle, 'sedentary', 'light', 'moderate'];
    const typeFallbacks = [dtype, 'type2'];
    for (const t of typeFallbacks) {
      for (const lf of lifeFallbacks) {
        const k = `${t}_${lf}`;
        if (EXERCISES[k]) return EXERCISES[k];
      }
    }
    return EXERCISES['type2_sedentary'];
  }

  // ── AGE NOTES ────────────────────────────
  const ageNotes = {
    young:   `At age ${age} (young adult): You have excellent recovery capacity. Push yourself with exercise. Build lifelong healthy habits now — they will protect you for decades.`,
    adult:   `At age ${age}: Balanced cardio + strength training is ideal. Prioritise sleep (8hrs) alongside diet — poor sleep raises glucose by up to 20%.`,
    midage:  `At age ${age}: Metabolism slows after 40. Portion control matters more now. Low-impact exercises (walking, swimming) are most sustainable.`,
    senior:  `At age ${age}: Focus on consistency over intensity. Walking daily is your single most powerful tool. Avoid skipping meals — hypoglycemia risk is higher.`,
    elderly: `At age ${age}: Gentle, supervised exercise is key. Prioritize hydration — seniors often underdrink. Chair exercises and gentle yoga are safe and effective.`,
  };

  const diet = findDiet(dtype, sugarTier, ageBracket);
  const exs  = findExercise(dtype, lifestyle);
  const ageNote = ageNotes[ageBracket];

  // ── CHEAT DAY LOGIC ──────────────────────
  // Only available if sugar is controlled (avg 70–140 mg/dL)
  const cheatDayAllowed = avgGluc !== null && avgGluc >= 70 && avgGluc <= 140;

  const cheatDay = {
    allowed: cheatDayAllowed,
    currentAvg: avgGluc,
    day: 'Sunday', // recommended cheat day
    foods: [
      { cat:'🍽️ Food', items:['1 small piece of homemade dessert (halwa or kheer — small portion)', '1 slice of whole grain pizza (thin crust)', '1 small portion of biryani (with raita)', 'A small serving of your favourite home-cooked curry with rice'] },
      { cat:'🥤 Drinks', items:['Fresh fruit lassi (1 glass — no extra sugar)', 'Coconut water (1 glass)', '1 small glass of fresh-squeezed juice (no added sugar)', 'Herbal mocktail (lime + mint + soda — no sugar)'] },
      { cat:'🍫 Treats', items:['1 small piece of dark chocolate (70%+ cocoa)', '2–3 dates with nuts', '1 scoop of low-sugar ice cream', 'Small serving of fruit custard (low-fat, no sugar added)'] },
    ],
    rules: [
      'Check your glucose before the cheat meal — must be below 140 mg/dL',
      'Walk for 20–30 minutes after the cheat meal to help burn the extra glucose',
      'Only 1 cheat meal — not the entire day',
      'Drink extra water (1–2 extra glasses) during and after the cheat meal',
      'Return to your normal plan the very next meal — no spillover into next day',
      'Monitor glucose 2 hours after the cheat meal',
      'If glucose crosses 180 after cheat meal — skip cheat day next week',
    ],
    lockReason: avgGluc === null
      ? 'Log at least 3 glucose readings to unlock Cheat Day.'
      : `Your current avg glucose is ${avgGluc} mg/dL — needs to be between 70–140 mg/dL to unlock Cheat Day.`,
  };

  return { diet, exercises: exs, stepGoal, ageNote, sugarTier, avgGluc, ageBracket, cheatDay };
}

// ══════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════
function switchAuthTab(tab) {
  el('tab-login-btn').classList.toggle('active',  tab==='login');
  el('tab-signup-btn').classList.toggle('active', tab==='signup');
  el('panel-login').classList.toggle('active',  tab==='login');
  el('panel-signup').classList.toggle('active', tab==='signup');
}

async function doLogin() {
  const email = el('inp-login-email').value.trim().toLowerCase();
  const pass  = el('inp-login-pass').value;
  el('login-error').classList.add('hidden');
  if (!email || !pass) { setErr('login-error','Please enter email and password.'); return; }
  try {
    const data = await api('/auth/login', 'POST', { email, password: pass });
    APP.token = data.token;
    APP.user  = data.user;
    sessionStorage.setItem('dbx_token', data.token);
    await loadAppFromServer();
    if (!APP.onboarded) startOnboarding();
    else startApp();
  } catch(e) {
    setErr('login-error', e.message || 'Login failed. Check your credentials.');
  }
}

async function doSignup() {
  const name  = el('inp-signup-name').value.trim();
  const email = el('inp-signup-email').value.trim().toLowerCase();
  const pass  = el('inp-signup-pass').value;
  el('signup-error').classList.add('hidden');
  if (!name||!email||!pass) { setErr('signup-error','All fields are required.'); return; }
  if (pass.length < 6)      { setErr('signup-error','Password must be at least 6 characters.'); return; }
  try {
    const data = await api('/auth/signup', 'POST', { name, email, password: pass });
    APP.token = data.token;
    APP.user  = data.user;
    sessionStorage.setItem('dbx_token', data.token);
    APP = { ...APP, profile:{}, readings:[], medications:[], contacts:[], steps:0, safetyLog:[], onboarded:false };
    startOnboarding();
  } catch(e) {
    setErr('signup-error', e.message || 'Signup failed. Please try again.');
  }
}

function setErr(id, msg) {
  const e = el(id); e.textContent = msg; e.classList.remove('hidden');
}

async function doLogout() {
  try { await api('/auth/logout', 'POST'); } catch(e) {}
  APP.token = null;
  sessionStorage.removeItem('dbx_token');
  stopSafetySystem();
  if (dashChart)  { dashChart.destroy();  dashChart  = null; }
  if (trendChart) { trendChart.destroy(); trendChart = null; }
  APP = { user:null, token:null, profile:{}, readings:[], medications:[], contacts:[], steps:0, safetyLog:[], onboarded:false };
  el('screen-app').classList.remove('active');
  el('screen-onboard').classList.remove('active');
  el('screen-auth').classList.add('active');
  el('inp-login-email').value = '';
  el('inp-login-pass').value  = '';
  el('login-error').classList.add('hidden');
}

// ══════════════════════════════════════════
//  ONBOARDING
// ══════════════════════════════════════════
let obData = {};

function startOnboarding() {
  el('screen-auth').classList.remove('active');
  el('screen-app').classList.remove('active');
  el('screen-onboard').classList.add('active');
  obData = {};
  showObPanel(1);
}

function showObPanel(n) {
  [1,2,3,4].forEach(i => {
    el('ob-panel-'+i).classList.toggle('active', i===n);
    const step = el('obs-'+i);
    step.classList.remove('active','done');
    if (i === n) step.classList.add('active');
    else if (i < n) step.classList.add('done');
  });
}

function obNext(step) {
  if (step === 1) {
    const name   = el('ob-name').value.trim();
    const age    = el('ob-age').value;
    const gender = el('ob-gender').value;
    const weight = el('ob-weight').value;
    const height = el('ob-height').value;
    const life   = el('ob-lifestyle').value;
    if (!name || !age) { setErr('ob-err-1','Please enter your name and age.'); return; }
    obData = { ...obData, name, age, gender, weight, height, lifestyle:life };
    el('ob-err-1').classList.add('hidden');
    showObPanel(2);
  } else if (step === 2) {
    const dtype = el('ob-dtype').value;
    const year  = el('ob-year').value;
    const low   = el('ob-low').value  || '80';
    const high  = el('ob-high').value || '140';
    obData = { ...obData, dtype, year, low, high,
      medsText:  el('ob-meds-text').value,
      allergies: el('ob-allergies').value,
      doc:       el('ob-doc').value };
    el('ob-err-2').classList.add('hidden');
    showObPanel(3);
  } else if (step === 3) {
    const ecName  = el('ob-ec-name').value.trim();
    const ecPhone = el('ob-ec-phone').value.trim();
    const ecRel   = el('ob-ec-rel').value.trim();
    if (!ecName || !ecPhone) { setErr('ob-err-3','Primary emergency contact name and phone are required.'); return; }
    el('ob-err-3').classList.add('hidden');
    obData = { ...obData, ecName, ecPhone, ecRel,
      ec2Name:  el('ob-ec2-name').value.trim(),
      ec2Phone: el('ob-ec2-phone').value.trim() };
    // Save contacts
    APP.contacts = [{ id:1, name:ecName, phone:ecPhone, rel:ecRel||'Emergency' }];
    if (obData.ec2Name && obData.ec2Phone) {
      APP.contacts.push({ id:2, name:obData.ec2Name, phone:obData.ec2Phone, rel:'Backup' });
    }
    // Build plan preview — wrapped in try/catch so preview error never blocks navigation
    APP.profile = { ...APP.profile, ...obData };
    try {
      const plan = buildPlan();
      renderObPlanPreview(plan);
    } catch(e) {
      console.warn('Plan preview error (non-critical):', e);
      el('ob-plan-preview').innerHTML = '<div class="ob-plan-item"><div class="ob-plan-label">Profile Saved</div><div class="ob-plan-text">Your profile has been set up. Log glucose readings to activate your personalised plan.</div></div>';
    }
    showObPanel(4);
  }
}

function obBack(step) {
  showObPanel(step - 1);
}

function renderObPlanPreview(plan) {
  const p = APP.profile;
  const typeLabels = { type1:'Type 1 Diabetes', type2:'Type 2 Diabetes', prediabetes:'Pre-diabetes', gestational:'Gestational Diabetes' };
  const lifeLabels = { sedentary:'Sedentary', light:'Light Activity', moderate:'Moderate Active', active:'Active' };
  const dietNote = (plan.diet && plan.diet.note) ? plan.diet.note : 'Log glucose readings after setup to get your personalised diet plan.';
  const items = [
    { label:'Your Profile',        text:`${p.name||'—'}, ${p.age||'—'} years old · ${typeLabels[p.dtype]||p.dtype||'—'} · ${lifeLabels[p.lifestyle]||p.lifestyle||'—'}` },
    { label:'Daily Step Goal',     text:`${(plan.stepGoal||8000).toLocaleString()} steps/day` },
    { label:'Age-specific Advice', text:plan.ageNote||'Consistent exercise and diet will keep your glucose stable.' },
    { label:'Your Diet Approach',  text:dietNote },
    { label:'Emergency Contact',   text:`${p.ecName||'—'} (${p.ecRel||'—'}) — ${p.ecPhone||'—'}` },
  ];
  el('ob-plan-preview').innerHTML = items.map(i=>`
    <div class="ob-plan-item">
      <div class="ob-plan-label">${i.label}</div>
      <div class="ob-plan-text">${i.text}</div>
    </div>`).join('');
}

async function finishOnboarding() {
  APP.profile = { ...APP.profile, ...obData };
  APP.onboarded = true;
  const plan = buildPlan();
  APP.profile.stepGoal = plan.stepGoal;
  const p = APP.profile;
  try {
    await api('/profile', 'PUT', {
      age: parseInt(p.age)||null, gender: p.gender,
      weight_kg: parseFloat(p.weight)||null, height_cm: parseFloat(p.height)||null,
      lifestyle: p.lifestyle, dtype: p.dtype,
      diagnosed_year: parseInt(p.year)||null,
      target_low: parseInt(p.low)||80, target_high: parseInt(p.high)||140,
      doctor_name: p.doc||'', allergies: p.allergies||'',
      meds_text: p.medsText||'', step_goal: plan.stepGoal,
    });
    // Save emergency contacts from onboarding
    if (p.ecName && p.ecPhone) {
      await api('/contacts', 'POST', { name:p.ecName, phone:p.ecPhone, relationship:p.ecRel||'Emergency' });
    }
    if (p.ec2Name && p.ec2Phone) {
      await api('/contacts', 'POST', { name:p.ec2Name, phone:p.ec2Phone, relationship:'Backup' });
    }
    await loadAppFromServer();
  } catch(e) { console.warn('Profile save error:', e); }
  el('screen-onboard').classList.remove('active');
  startApp();
}

// ══════════════════════════════════════════
//  APP BOOT
// ══════════════════════════════════════════
function startApp() {
  el('screen-auth').classList.remove('active');
  el('screen-onboard').classList.remove('active');
  el('screen-app').classList.add('active');
  // Session stored in sessionStorage via token

  const name = APP.profile.name || APP.user.name || 'User';
  el('topbar-avatar').textContent = name[0].toUpperCase();
  el('sidebar-user').textContent  = '👤 ' + name;

  // Restore profile fields
  restoreProfileFields();
  goTo('dashboard');
  startSafetySystem();
  startMedReminder();
}

function restoreProfileFields() {
  const p = APP.profile;
  const setVal = (id, v) => { if (v && el(id)) el(id).value = v; };
  setVal('p-name', p.name); setVal('p-age', p.age); setVal('p-weight', p.weight);
  setVal('p-height', p.height); setVal('p-year', p.year); setVal('p-doc', p.doc);
  setVal('p-low', p.low); setVal('p-high', p.high); setVal('p-allergies', p.allergies);
  if (p.gender)    { try { el('p-gender').value    = p.gender;    } catch(e){} }
  if (p.dtype)     { try { el('p-dtype').value     = p.dtype;     } catch(e){} }
  if (p.lifestyle) { try { el('p-lifestyle').value = p.lifestyle; } catch(e){} }
}

// ══════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════
function goTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const pageEl = el('page-'+page);
  if (!pageEl) return;
  pageEl.classList.add('active');
  const navBtn = document.querySelector('.nav-btn[data-page="'+page+'"]');
  if (navBtn) navBtn.classList.add('active');
  const names = { dashboard:'Dashboard', sugar:'Sugar Entry', trends:'Trends', ai:'AI Predictions',
    diet:'Diet & Exercise', meds:'Medications', safety:'Safety Monitor', reports:'Reports', profile:'Profile' };
  el('topbar-page').textContent = names[page] || page;
  el('sidebar').classList.remove('open');

  if (page==='dashboard') renderDashboard();
  if (page==='sugar')     renderHistory();
  if (page==='trends')    renderTrend(7);
  if (page==='ai')        renderAI();
  if (page==='diet')      renderDiet();
  if (page==='meds')      renderMeds();
  if (page==='safety')    renderSafetyPage();
  if (page==='reports')   renderReportStats();
}

function toggleSidebar() { el('sidebar').classList.toggle('open'); }

// ══════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════
function renderDashboard() {
  const name = (APP.profile.name || APP.user.name || 'User').split(' ')[0];
  el('dash-username').textContent = name;
  if (APP.readings.length) {
    const last = APP.readings[APP.readings.length-1];
    el('d-glucose').textContent      = last.value + ' mg/dL';
    el('d-glucose-time').textContent = fmtTime(last.ts);
  }
  const sc = healthScore();
  if (sc !== null) { el('d-score').textContent = sc; el('topbar-score').textContent = 'Score: '+sc; }
  const risk = calcRisk();
  el('d-risk').textContent     = risk.level;
  el('d-risk-sub').textContent = risk.level!=='Unknown' ? 'AI Assessment' : 'Awaiting data';
  el('d-steps').textContent    = APP.steps.toLocaleString();
  el('d-step-goal').textContent= (APP.profile.stepGoal||8000).toLocaleString();
  renderTodayPlan();
  renderDashChart();
}

function renderTodayPlan() {
  const plan = buildPlan();
  const p = APP.profile;
  const typeLabels = { type1:'Type 1', type2:'Type 2', prediabetes:'Pre-diabetes', gestational:'Gestational' };
  const items = [
    { icon:'🥗', text: plan.diet.breakfast[0] + ' for breakfast' },
    { icon:'👟', text: `Walk ${(APP.profile.stepGoal||8000).toLocaleString()} steps today` },
    { icon:'🩺', text: `Type: ${typeLabels[p.dtype]||p.dtype||'--'} · Target: ${p.low||80}–${p.high||140} mg/dL` },
    { icon:'💊', text: APP.medications.length ? `${APP.medications.length} medication(s) to take today` : 'No medications set' },
  ];
  el('d-today-plan').innerHTML = items.map(i=>`
    <div class="tp-item"><span class="tp-icon">${i.icon}</span><span>${i.text}</span></div>
  `).join('');
}

function renderDashChart() {
  const ctx    = el('dash-chart');
  const noData = el('dash-no-data');
  const data7  = getFiltered(7);
  if (!data7.length) { ctx.style.display='none'; noData.classList.remove('hidden'); return; }
  ctx.style.display=''; noData.classList.add('hidden');
  if (dashChart) dashChart.destroy();
  dashChart = new Chart(ctx, {
    type:'line',
    data:{
      labels: data7.map(r=>new Date(r.ts).toLocaleDateString('en-IN',{weekday:'short',day:'numeric'})),
      datasets:[{ label:'Glucose', data:data7.map(r=>r.value),
        borderColor:'#00d4aa', backgroundColor:'rgba(0,212,170,0.08)',
        tension:0.4, fill:true,
        pointBackgroundColor:data7.map(r=>r.value<70||r.value>300?'#f0526e':'#00d4aa'), pointRadius:4 }]
    },
    options:{ responsive:true, plugins:{ legend:{display:false} },
      scales:{
        x:{grid:{color:'#2a3140'},ticks:{color:'#7d8fa1',font:{size:11}}},
        y:{grid:{color:'#2a3140'},ticks:{color:'#7d8fa1',font:{size:11}},min:50,suggestedMax:300}
      }
    }
  });
}

// ══════════════════════════════════════════
//  GLUCOSE LOGGING
// ══════════════════════════════════════════
function quickLog() {
  const val = parseInt(el('q-val').value), meal = el('q-meal').value;
  if (!doLog(val, meal, '', 'q-alert')) return;
  el('q-val').value = '';
  renderDashboard();
}

function logSugar() {
  const val  = parseInt(el('se-val').value);
  const meal = el('se-meal').value;
  const note = el('se-note').value.trim();
  if (!doLog(val, meal, note, 'se-alert')) return;
  el('se-val').value=''; el('se-note').value='';
  renderHistory();
}

function doLog(val, meal, note, alertId) {
  if (isNaN(val)||val<20||val>800) {
    showAlert(alertId,'⚠ Enter a valid glucose value between 20 and 800 mg/dL','warn'); return false;
  }
  const info = classify(val);
  const reading = { id: Date.now(), value:val, meal, note, ts:Date.now(), label:info.label };
  APP.readings.push(reading);
  // Save to backend (fire and forget — UI already updated)
  api('/glucose', 'POST', { value:val, meal_context:meal, note:note||'' })
    .then(r => { reading.id = r.id; })
    .catch(()=>{});
  if (val < 70) {
    showAlert(alertId,`🚨 Hypoglycemia! ${val} mg/dL — take fast-acting sugar immediately!`,'danger');
    toast('🚨 Low blood sugar detected!','danger');
    addSafetyLog('danger', `Hypoglycemia alert: ${val} mg/dL logged`);
  } else if (val > 300) {
    showAlert(alertId,`🚨 Critical glucose! ${val} mg/dL — seek medical help immediately!`,'danger');
    toast('🚨 Critical glucose level!','danger');
    addSafetyLog('danger', `Critical glucose alert: ${val} mg/dL logged`);
  } else {
    showAlert(alertId,`✓ Recorded: ${val} mg/dL — ${info.label}`,'ok');
    toast('Glucose logged: '+val+' mg/dL','ok');
  }
  const sc = healthScore();
  if (sc!==null) { if(el('d-score')) el('d-score').textContent=sc; el('topbar-score').textContent='Score: '+sc; }
  return true;
}

function renderHistory() {
  const wrap = el('sugar-history');
  const p = APP.profile;
  el('target-display').innerHTML = p.low && p.high
    ? `Your target range: <strong>${p.low}–${p.high} mg/dL</strong> (${p.dtype||'diabetes'} type)`
    : 'Set your target range in Profile.';
  if (!APP.readings.length) { wrap.innerHTML='<div class="empty-msg">No readings yet — log your first above.</div>'; return; }
  wrap.innerHTML = [...APP.readings].reverse().slice(0,30).map(r=>{
    const info=classify(r.value);
    return `<div class="hist-row">
      <span class="hval">${r.value} <small style="font-size:11px;font-weight:400">mg/dL</small></span>
      <span class="hbadge ${info.cls}">${info.label}</span>
      <span class="hmeal">${r.meal.replace('_',' ')}</span>
      <span class="htime">${fmtTime(r.ts)}</span>
    </div>`;
  }).join('');
}

// ══════════════════════════════════════════
//  TRENDS
// ══════════════════════════════════════════
function setFilter(days, btn) {
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderTrend(days);
}

function renderTrend(days) {
  const data   = getFiltered(days);
  const ctx    = el('trend-chart');
  const noData = el('trend-no-data');
  if (data.length) {
    const vals = data.map(r=>r.value);
    el('t-avg').textContent   = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
    el('t-max').textContent   = Math.max(...vals);
    el('t-min').textContent   = Math.min(...vals);
    el('t-range').textContent = inRangePct(data);
    ctx.style.display=''; noData.classList.add('hidden');
  } else {
    ['t-avg','t-max','t-min','t-range'].forEach(id=>el(id).textContent='--');
    ctx.style.display='none'; noData.classList.remove('hidden');
  }
  if (trendChart) trendChart.destroy();
  if (!data.length) return;
  trendChart = new Chart(ctx, {
    type:'line',
    data:{
      labels:data.map(r=>new Date(r.ts).toLocaleDateString('en-IN',{month:'short',day:'numeric'})),
      datasets:[{ label:'Glucose (mg/dL)', data:data.map(r=>r.value),
        borderColor:'#00d4aa', backgroundColor:'rgba(0,212,170,0.07)', tension:0.4, fill:true,
        pointBackgroundColor:data.map(r=>r.value<70||r.value>300?'#f0526e':r.value>180?'#f5a623':'#00d4aa'), pointRadius:5 }]
    },
    options:{ responsive:true,
      plugins:{ legend:{labels:{color:'#7d8fa1',font:{size:12}}}, tooltip:{backgroundColor:'#1e2530',borderColor:'#2a3140',borderWidth:1} },
      scales:{
        x:{grid:{color:'#2a3140'},ticks:{color:'#7d8fa1',font:{size:11}}},
        y:{grid:{color:'#2a3140'},ticks:{color:'#7d8fa1',font:{size:11}},min:50,suggestedMax:300}
      }
    }
  });
}

// ══════════════════════════════════════════
//  AI
// ══════════════════════════════════════════
function renderAI() {
  const sc = healthScore(), risk = calcRisk();
  el('ai-risk-fill').style.width  = risk.pct+'%';
  el('ai-risk-badge').textContent = risk.level;
  el('ai-risk-badge').className   = 'rbadge '+risk.cls;
  if (sc!==null) {
    el('ring-num').textContent = sc;
    el('topbar-score').textContent = 'Score: '+sc;
    el('ring-prog').style.strokeDashoffset = 314-(314*sc/100);
    if (APP.readings.length) {
      const avg = APP.readings.slice(-10).reduce((s,r)=>s+r.value,0)/Math.min(APP.readings.length,10);
      el('sc-gluc').textContent = avg<130?'Good':avg<180?'Fair':'Poor';
      el('sc-act').textContent  = APP.steps>=(APP.profile.stepGoal||8000)?'Good':APP.steps>=4000?'Fair':'Low';
      el('sc-med').textContent  = APP.medications.length?'Tracked':'Not Set';
    }
  } else { el('ring-num').textContent='--'; }
}

function runAI() {
  if (!APP.readings.length) {
    el('ai-output').textContent='⚠ No readings found. Log at least 3 glucose readings first.';
    el('ai-output').classList.remove('hidden'); return;
  }
  const risk = calcRisk(), sc = healthScore();
  const avg = Math.round(APP.readings.slice(-7).reduce((s,r)=>s+r.value,0)/Math.min(APP.readings.length,7));
  const msgs = {
    Low:      `✅ Risk is LOW. Avg glucose: ${avg} mg/dL — well controlled. Health score: ${sc}/100. Maintain your current routine.`,
    Moderate: `⚠️ MODERATE risk. Avg: ${avg} mg/dL. Recommendations: increase walking to ${(APP.profile.stepGoal||8000).toLocaleString()} steps, reduce refined carbs, monitor every 6 hours.`,
    High:     `🔴 HIGH risk. Avg: ${avg} mg/dL. Contact your doctor immediately. Monitor every 3–4 hours, strictly follow medication, avoid sugar.`,
    Critical: `🚨 CRITICAL. Dangerous glucose levels. Contact emergency services NOW or ask someone for help immediately.`,
    Unknown:  `ℹ️ Not enough data. Log at least 3 glucose readings for AI analysis.`,
  };
  el('ai-output').innerHTML = msgs[risk.level]||msgs.Unknown;
  el('ai-output').classList.remove('hidden');
  renderAI();
  toast('AI analysis complete!','ok');
}

// ══════════════════════════════════════════
//  DIET & EXERCISE  (v3 — sugar-aware + cheat day)
// ══════════════════════════════════════════
function renderDiet() {
  const plan = buildPlan();
  const p    = APP.profile;
  const typeLabels = { type1:'Type 1 Diabetes', type2:'Type 2 Diabetes', prediabetes:'Pre-diabetes', gestational:'Gestational Diabetes' };
  const lifeLabels = { sedentary:'Sedentary', light:'Light Activity', moderate:'Moderate Active', active:'Active' };

  // Sugar tier colours
  const tierMeta = {
    unknown:     { color:'var(--muted)',   icon:'📊', label:'No Readings Yet' },
    hypo:        { color:'var(--blue)',    icon:'⬇️',  label:'Low Glucose (Hypo)' },
    controlled:  { color:'var(--teal)',    icon:'✅',  label:'Well Controlled' },
    mildHigh:    { color:'#a3e635',        icon:'🟡',  label:'Slightly Elevated' },
    high:        { color:'var(--amber)',   icon:'⚠️',  label:'High' },
    veryHigh:    { color:'var(--rose)',    icon:'🔴',  label:'Very High' },
    critical:    { color:'var(--red)',     icon:'🚨',  label:'Critical' },
  };
  const tm = tierMeta[plan.sugarTier] || tierMeta.unknown;

  // ── Profile banner ───────────────────────
  el('diet-profile-banner').innerHTML = `
    <div class="pb-avatar">${p.gender==='female'?'👩':'👨'}</div>
    <div class="pb-info">
      <strong>${p.name||'Patient'}, Age ${p.age||'--'}</strong>
      <p>${typeLabels[p.dtype]||'Diabetes'} · ${lifeLabels[p.lifestyle]||'--'} · Goal: ${plan.stepGoal.toLocaleString()} steps/day</p>
    </div>
    <div class="pb-sugar-status" style="border-color:${tm.color};background:${tm.color}18">
      <div style="font-size:20px">${tm.icon}</div>
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Avg Glucose</div>
        <div style="font-size:15px;font-weight:700;color:${tm.color}">${plan.avgGluc!==null?plan.avgGluc+' mg/dL':'No data'}</div>
        <div style="font-size:11px;color:${tm.color}">${tm.label}</div>
      </div>
    </div>`;

  // ── Sugar-level alert banner ─────────────
  const alertMap = {
    unknown:    { msg:'Log glucose readings to get your personalised diet plan.', type:'warn' },
    hypo:       { msg:'⚠️ Your glucose is LOW. Your plan focuses on safe glucose recovery. Always carry sugar tablets.', type:'danger' },
    controlled: { msg:'✅ Excellent! Your glucose is well-controlled. Your plan maintains this balance.', type:'ok' },
    mildHigh:   { msg:'⚠️ Glucose is slightly elevated. Your plan reduces carbs and increases fibre to bring it down.', type:'warn' },
    high:       { msg:'🔴 High glucose detected. Strict low-carb plan activated. Consult your doctor this week.', type:'danger' },
    veryHigh:   { msg:'🚨 Very high glucose. Emergency dietary restrictions applied. Medical attention required.', type:'danger' },
    critical:   { msg:'🚨 CRITICAL glucose levels. This is a medical emergency. Contact your doctor NOW.', type:'danger' },
  };
  const al = alertMap[plan.sugarTier];

  // ── Diet plan ────────────────────────────
  const d = plan.diet;
  const mealHtml = [
    { label:'🌅 Breakfast', items:d.breakfast },
    { label:'☀️ Lunch',     items:d.lunch },
    { label:'🌙 Dinner',    items:d.dinner },
    { label:'🍎 Snacks',    items:d.snacks },
  ].map(m=>`
    <div class="diet-meal">
      <div class="dm-label">${m.label}</div>
      <div class="dm-items">${m.items.map(i=>`<div class="dm-item">${i}</div>`).join('')}</div>
    </div>`).join('');

  el('diet-plan-content').innerHTML = `
    <div class="inline-alert ${al.type}" style="display:flex;margin-bottom:14px">${al.msg}</div>
    <div class="diet-meals">${mealHtml}</div>
    <div class="inline-alert ok mt16" style="display:flex">ℹ️ &nbsp;${d.note}</div>
    <div class="inline-alert warn mt16" style="display:flex">💡 &nbsp;${plan.ageNote}</div>
    <div class="inline-alert ok mt16" style="display:flex">📏 &nbsp;${d.portionNote||''}</div>`;

  // ── Exercise plan ────────────────────────
  el('exercise-plan-content').innerHTML = `<div class="ex-plan">${plan.exercises.map(e=>`
    <div class="ex-item">
      <div class="ex-icon">${e.icon}</div>
      <div>
        <div class="ex-name">${e.name}</div>
        <div class="ex-detail">${e.detail}</div>
        <span class="ex-badge">${e.badge}</span>
      </div>
    </div>`).join('')}</div>`;

  // ── Foods to avoid ───────────────────────
  el('avoid-foods-content').innerHTML = `<div class="avoid-list">${d.avoid.map(f=>`<div class="avoid-item">🚫 ${f}</div>`).join('')}</div>`;

  // ── Walk tracker ─────────────────────────
  el('w-steps').textContent        = APP.steps.toLocaleString();
  el('w-goal-display').textContent = plan.stepGoal.toLocaleString();
  updateWalkBar();

  // ── Cheat Day section ────────────────────
  renderCheatDay(plan.cheatDay);
}

function renderCheatDay(cd) {
  const wrap = el('cheat-day-section');
  if (!wrap) return;

  if (!cd.allowed) {
    // LOCKED
    wrap.innerHTML = `
      <div class="cheat-locked">
        <div class="cheat-lock-icon">🔒</div>
        <div class="cheat-lock-title">Cheat Day — Locked</div>
        <div class="cheat-lock-reason">${cd.lockReason}</div>
        <div class="cheat-lock-tip">Keep your glucose in the 70–140 mg/dL range to unlock your weekly cheat day!</div>
        ${cd.currentAvg !== null ? `<div class="cheat-lock-bar-wrap">
          <div class="cheat-lock-bar-track">
            <div class="cheat-lock-bar-fill" style="width:${Math.min(100,Math.round(Math.max(0,(140-Math.abs(cd.currentAvg-110))/70*100)))}%"></div>
          </div>
          <div class="cheat-lock-bar-label">Current avg: ${cd.currentAvg} mg/dL</div>
        </div>` : ''}
      </div>`;
    return;
  }

  // UNLOCKED
  const foodsHtml = cd.foods.map(f=>`
    <div class="cheat-cat">
      <div class="cheat-cat-label">${f.cat}</div>
      <div class="cheat-items">${f.items.map(i=>`<div class="cheat-item">✓ ${i}</div>`).join('')}</div>
    </div>`).join('');

  const rulesHtml = cd.rules.map(r=>`<div class="cheat-rule">⚡ ${r}</div>`).join('');

  wrap.innerHTML = `
    <div class="cheat-unlocked">
      <div class="cheat-header">
        <div class="cheat-badge-icon">🎉</div>
        <div>
          <div class="cheat-title">Cheat Day Unlocked — Every ${cd.day}!</div>
          <div class="cheat-subtitle">Your avg glucose is ${cd.currentAvg} mg/dL — well controlled. You've earned it!</div>
        </div>
        <div class="cheat-status-pill">✅ ACTIVE</div>
      </div>
      <div class="cheat-foods-grid">${foodsHtml}</div>
      <div class="cheat-rules-section">
        <div class="cheat-rules-title">📋 Cheat Day Rules — Follow These!</div>
        <div class="cheat-rules-list">${rulesHtml}</div>
      </div>
      <div class="inline-alert warn mt16" style="display:flex">⚠️ &nbsp;If your glucose goes above 180 mg/dL after cheat day, it is suspended next week automatically.</div>
    </div>`;
}

async function addSteps() {
  const s = parseInt(el('step-inp').value);
  if (isNaN(s)||s<=0) { toast('Enter a valid step count','warn'); return; }
  APP.steps = Math.min(APP.steps+s, 99999);
  el('step-inp').value='';
  el('w-steps').textContent = APP.steps.toLocaleString();
  if(el('d-steps')) el('d-steps').textContent = APP.steps.toLocaleString();
  updateWalkBar();
  toast('+'+s+' steps added!','ok');
  api('/profile', 'PUT', { steps_today: APP.steps }).catch(()=>{});
}

function updateWalkBar() {
  const goal = APP.profile.stepGoal || 8000;
  const pct  = Math.min(100, Math.round(APP.steps/goal*100));
  if(el('w-fill')) el('w-fill').style.width = pct+'%';
  if(el('w-pct'))  el('w-pct').textContent  = pct+'%';
}

// ══════════════════════════════════════════
//  MEDICATIONS
// ══════════════════════════════════════════
async function addMed() {
  const name=el('m-name').value.trim(), dose=el('m-dose').value.trim();
  const time=el('m-time').value, freq=el('m-freq').value;
  if (!name||!dose) { toast('Enter medication name and dosage','warn'); return; }
  try {
    const med = await api('/medications', 'POST', { name, dose, time_of_day:time, frequency:freq });
    APP.medications.push({ id:med.id, name:med.name, dose:med.dose, time:med.time_of_day, freq:med.frequency, done:!!med.is_done });
    el('m-name').value=''; el('m-dose').value='';
    renderMeds();
    toast('Reminder set for '+name,'ok');
  } catch(e) { toast('Failed to save medication','warn'); }
}

async function toggleMed(id) {
  const m = APP.medications.find(x=>x.id===id);
  if (!m) return;
  m.done = !m.done;
  renderMeds();
  api('/medications/'+id+'/toggle', 'PATCH').catch(()=>{});
}

function renderMeds() {
  const wrap = el('med-list');
  if (!APP.medications.length) { wrap.innerHTML='<div class="empty-msg">No medications added yet.</div>'; return; }
  wrap.innerHTML = APP.medications.map(m=>`
    <div class="med-item">
      <div><div class="med-nm">${m.name} ${m.dose}</div><div class="med-info2">${m.time} — ${m.freq}</div></div>
      <button class="toggle-btn ${m.done?'done':''}" onclick="toggleMed(${m.id})">${m.done?'✓':'○'}</button>
    </div>`).join('');
}

function startMedReminder() {
  setInterval(()=>{
    if (!APP.user) return;
    const hhmm = new Date().toTimeString().slice(0,5);
    APP.medications.forEach(m=>{ if(m.time===hhmm&&!m.done) toast('💊 Time to take '+m.name+' '+m.dose,'warn'); });
  }, 60000);
}

// ══════════════════════════════════════════
//  SAFETY SYSTEM — CORE
// ══════════════════════════════════════════
function startSafetySystem() {
  safetyActive = true;
  safetySecondsLeft = SAFETY_INTERVAL_SEC;
  updateCountdownDisplay();
  safetyInterval  = setInterval(safetyTick,  1000);
}

function stopSafetySystem() {
  clearInterval(safetyInterval);
  clearTimeout(safetyPopupTimer);
  clearInterval(spAutoTimer);
  safetyInterval = null;
}

function toggleSafetySystem() {
  safetyActive = el('safety-toggle').checked;
  el('safety-status-label').textContent = safetyActive ? 'Active' : 'Paused';
  el('safety-status-label').className   = safetyActive ? 'ss-on' : 'ss-off';
  if (safetyActive) {
    safetySecondsLeft = SAFETY_INTERVAL_SEC;
    updateCountdownDisplay();
    toast('Safety monitor activated','ok');
    addSafetyLog('ok', 'Safety system reactivated');
  } else {
    toast('Safety monitor paused','warn');
    addSafetyLog('warn', 'Safety system paused by user');
  }
}

function safetyTick() {
  if (!safetyActive || !APP.user) return;
  safetySecondsLeft--;
  updateCountdownDisplay();
  if (safetySecondsLeft <= 0) {
    safetySecondsLeft = SAFETY_INTERVAL_SEC;
    showSafetyPopup();
  }
}

function updateCountdownDisplay() {
  const cd = el('ss-countdown');
  if (cd) cd.textContent = fmtSec(safetySecondsLeft);
}

// ══════════════════════════════════════════
//  SAFETY POPUP
// ══════════════════════════════════════════
let spTimerInterval = null;
let spAutoSeconds   = POPUP_TIMEOUT_SEC;

function showSafetyPopup() {
  // Reset to step 1
  ['sp-step1','sp-step2','sp-step3','sp-step4'].forEach(id=>el(id).classList.remove('active'));
  el('sp-step1').classList.add('active');

  // Uncheck all symptoms
  document.querySelectorAll('.symptom-item input').forEach(cb=>cb.checked=false);

  // Set time
  el('sp-time').textContent = new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'});

  // Show popup
  el('safety-popup').classList.remove('hidden');

  // Start auto-countdown
  spAutoSeconds = POPUP_TIMEOUT_SEC;
  el('sp-auto-countdown').textContent = spAutoSeconds;

  // Animate timer bar
  const fill = el('sp-timer-fill');
  fill.style.transition = 'none';
  fill.style.width = '100%';
  setTimeout(()=>{
    fill.style.transition = `width ${POPUP_TIMEOUT_SEC}s linear`;
    fill.style.width = '0%';
  }, 100);

  clearInterval(spTimerInterval);
  spTimerInterval = setInterval(()=>{
    spAutoSeconds--;
    el('sp-auto-countdown').textContent = spAutoSeconds;
    if (spAutoSeconds <= 0) {
      clearInterval(spTimerInterval);
      // No response — auto alert
      addSafetyLog('danger', 'No response to safety check — auto-alert triggered');
      triggerEmergencySequence('no_response', []);
    }
  }, 1000);
}

function spYes() {
  clearInterval(spTimerInterval);
  el('safety-popup').classList.add('hidden');
  addSafetyLog('ok', 'Safety check confirmed: User is okay');
  toast('✓ Wellbeing confirmed','ok');
}

function spNo() {
  clearInterval(spTimerInterval);
  // Show symptom checker
  el('sp-step1').classList.remove('active');
  el('sp-step2').classList.add('active');
}

function spMild() {
  const symptoms = getSelectedSymptoms();
  el('sp-step2').classList.remove('active');
  el('sp-step4').classList.add('active');

  const tips = {
    dizziness:       'Sit or lie down. Drink water. Check glucose immediately.',
    sweating:        'Check your glucose — could be hypoglycemia. Have sugar ready.',
    trembling:       'Eat something with fast-acting sugar (glucose tablets, juice).',
    confusion:       'This could be severe hypoglycemia. Ask someone nearby for help.',
    blurred_vision:  'Rest your eyes. Check blood pressure and glucose.',
    chest_pain:      '⚠️ Chest pain is serious. Call your doctor now.',
    nausea:          'Sip water slowly. Avoid food until nausea passes. Check glucose.',
    headache:        'Hydrate. Check glucose. Rest in a cool place.',
    extreme_fatigue: 'Rest immediately. Check glucose. Avoid driving.',
    unconscious:     '⚠️ Feeling faint is serious — sit down and call someone nearby.',
  };

  const tipHtml = symptoms.length
    ? symptoms.map(s=>`<div>• ${tips[s]||s}</div>`).join('')
    : '<div>• Monitor yourself closely and check glucose in 15 minutes.</div>';

  el('sp-mild-tips').innerHTML = tipHtml;
  addSafetyLog('warn', `Mild symptoms reported: ${symptoms.join(', ')||'general discomfort'}`);
  toast('Symptoms logged. Rechecking in 10 mins.','warn');
  // Recheck sooner
  safetySecondsLeft = 10 * 60;
}

function spSevere() {
  const symptoms = getSelectedSymptoms();
  el('sp-step2').classList.remove('active');
  el('sp-step3').classList.add('active');
  addSafetyLog('danger', `Severe symptoms reported: ${symptoms.join(', ')||'severe distress'}`);
  triggerEmergencySequence('severe', symptoms);
}

function getSelectedSymptoms() {
  return [...document.querySelectorAll('.symptom-item input:checked')].map(cb=>cb.value);
}

function spClose() {
  el('safety-popup').classList.add('hidden');
  safetySecondsLeft = SAFETY_INTERVAL_SEC;
}

// ══════════════════════════════════════════
//  EMERGENCY SEQUENCE
// ══════════════════════════════════════════
function triggerEmergencySequence(reason, symptoms) {
  // Make sure step 3 is visible
  ['sp-step1','sp-step2','sp-step4'].forEach(id=>{ if(el(id)) el(id).classList.remove('active'); });
  if(el('sp-step3')) el('sp-step3').classList.add('active');
  if(el('safety-popup').classList.contains('hidden')) el('safety-popup').classList.remove('hidden');

  const logEl = el('sp-alert-log');
  if(logEl) logEl.innerHTML='';

  function addLog(msg, type, delay=0) {
    setTimeout(()=>{
      const emoji = type==='sent'?'✓':type==='failed'?'✗':'⟳';
      if(logEl) logEl.innerHTML += `<div class="sp-al-item ${type}">${emoji} ${msg}</div>`;
    }, delay);
  }

  // Simulated sequence
  addLog('Getting your GPS location...', 'sending', 0);

  getLocation(location => {
    addLog(`Location: ${location}`, 'sent', 500);
    addLog('Preparing emergency message...', 'sending', 800);

    const reasonText = reason==='no_response'
      ? 'did not respond to safety check'
      : `reported severe symptoms: ${symptoms.join(', ')||'distress'}`;

    const contacts = APP.contacts;

    if (!contacts.length) {
      addLog('⚠ No emergency contacts set! Please add contacts.', 'failed', 1200);
      el('sp-alert-msg').textContent = 'No emergency contacts set. Please go to Safety Monitor to add contacts.';
      addSafetyLog('danger', 'Emergency alert failed — no contacts set');
      return;
    }

    // Alert primary contact
    const primary = contacts[0];
    addLog(`Alerting ${primary.name} (${primary.phone})...`, 'sending', 1400);
    addLog(`SMS sent to ${primary.name}: "${APP.profile.name||'Patient'} needs help. Location: ${location}"`, 'sent', 2200);

    // Alert backup if exists
    if (contacts.length > 1) {
      const backup = contacts[1];
      addLog(`Alerting backup: ${backup.name} (${backup.phone})...`, 'sending', 2800);
      addLog(`SMS sent to ${backup.name}`, 'sent', 3400);
    }

    // Simulate: if primary doesn't respond after a while, alert hospital
    setTimeout(()=>{
      addLog('Primary contact not responding — alerting nearest hospital...', 'sending', 0);
      setTimeout(()=>{
        addLog(`Emergency alert sent to nearest hospital: "Diabetic patient at ${location} needs assistance. Contact: ${primary.phone}"`, 'sent', 0);
        el('sp-alert-msg').textContent = 'All emergency contacts and nearest hospital have been notified with your location.';
        addSafetyLog('danger', `Emergency alert sent. Location shared: ${location}. Contacts: ${contacts.map(c=>c.name).join(', ')}`);
        toast('🚨 Emergency alert sent to all contacts + hospital!','danger');
      }, 1500);
    }, 5000);
  });
}

// ══════════════════════════════════════════
//  SAFETY PAGE
// ══════════════════════════════════════════
function renderSafetyPage() {
  renderContacts();
  renderSafetyLog();
  // Sync toggle
  el('safety-toggle').checked = safetyActive;
  el('safety-status-label').textContent = safetyActive ? 'Active' : 'Paused';
  el('safety-status-label').className   = safetyActive ? 'ss-on' : 'ss-off';
}

function manualOkay() {
  showAlert('manual-safety-msg','✓ Status confirmed at '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})+'. Stay safe!','ok');
  addSafetyLog('ok','Manual check-in: User confirmed okay');
  toast('Wellbeing confirmed ✓','ok');
}

function manualEmergency() {
  el('safety-popup').classList.remove('hidden');
  ['sp-step1','sp-step2','sp-step4'].forEach(id=>el(id).classList.remove('active'));
  el('sp-step3').classList.add('active');
  el('sp-alert-log').innerHTML='';
  addSafetyLog('danger','Manual emergency triggered by user');
  triggerEmergencySequence('manual',[]);
}

async function addContact() {
  const name=el('ec-name').value.trim(), phone=el('ec-phone').value.trim(), rel=el('ec-rel').value.trim();
  if (!name||!phone) { toast('Enter name and phone','warn'); return; }
  try {
    const c = await api('/contacts', 'POST', { name, phone, relationship:rel });
    APP.contacts.push({ id:c.id, name:c.name, phone:c.phone, rel:c.relationship });
    el('ec-name').value=''; el('ec-phone').value=''; el('ec-rel').value='';
    renderContacts();
    toast('Contact added: '+name,'ok');
  } catch(e) { toast('Failed to save contact','warn'); }
}

async function removeContact(id) {
  APP.contacts = APP.contacts.filter(c=>c.id!==id);
  renderContacts();
  toast('Contact removed','warn');
  api('/contacts/'+id, 'DELETE').catch(()=>{});
}

function renderContacts() {
  const wrap = el('contact-list');
  if (!wrap) return;
  if (!APP.contacts.length) { wrap.innerHTML=''; return; }
  wrap.innerHTML = APP.contacts.map(c=>`
    <div class="contact-item">
      <div><div class="cn">${c.name}</div><div class="cr">${c.rel||'Contact'}</div></div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="cp">${c.phone}</span>
        <button onclick="removeContact(${c.id})" style="background:none;border:none;color:var(--rose);cursor:pointer;font-size:16px">✕</button>
      </div>
    </div>`).join('');
}

function renderSafetyLog() {
  const wrap = el('safety-log');
  if (!wrap) return;
  if (!APP.safetyLog.length) { wrap.innerHTML='<div class="empty-msg">No safety events recorded yet.</div>'; return; }
  wrap.innerHTML = APP.safetyLog.slice(0,20).map(s=>`
    <div class="sl-item">
      <div class="sl-dot ${s.type}"></div>
      <div class="sl-text">${s.msg}</div>
      <div class="sl-time">${fmtTime(s.ts)}</div>
    </div>`).join('');
}

// ══════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════
function renderReportStats() {
  el('r-total').textContent = APP.readings.length;
  el('r-avg').textContent   = APP.readings.length ? Math.round(APP.readings.reduce((s,r)=>s+r.value,0)/APP.readings.length) : '--';
  el('r-hypo').textContent  = APP.readings.filter(r=>r.value<70).length;
  el('r-meds').textContent  = APP.medications.length;
}

function genReport() {
  const days = parseInt(el('rep-days').value);
  const data = getFiltered(days), risk = calcRisk(), sc = healthScore();
  if (!data.length) { el('rep-preview').innerHTML='<div class="empty-msg">No readings in this period.</div>'; return; }
  const vals=data.map(r=>r.value), avg=Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
  const p = APP.profile;
  lastReport = {
    generated: new Date().toISOString(), period: days+' days',
    patient: p.name||APP.user.name, age: p.age, gender: p.gender,
    diabetes_type: p.dtype, doctor: p.doc||'Not set',
    total_readings: data.length, avg_glucose: avg,
    max_glucose: Math.max(...vals), min_glucose: Math.min(...vals),
    in_range_pct: inRangePct(data),
    hypo_events: vals.filter(v=>v<70).length,
    high_events: vals.filter(v=>v>180).length,
    health_score: sc, risk_level: risk.level,
    medications: APP.medications.map(m=>m.name+' '+m.dose),
    steps_today: APP.steps, step_goal: APP.profile.stepGoal||8000,
    emergency_contacts: APP.contacts.map(c=>c.name+' '+c.phone),
  };
  el('rep-preview').innerHTML = `<div class="rep-content">
    <strong>Patient:</strong> ${lastReport.patient} (${lastReport.age||'--'} yrs, ${lastReport.gender||'--'})<br/>
    <strong>Type:</strong> ${lastReport.diabetes_type} &nbsp; <strong>Doctor:</strong> ${lastReport.doctor}<br/>
    <strong>Period:</strong> Last ${days} days &nbsp; <strong>Readings:</strong> ${data.length}<br/>
    <strong>Avg Glucose:</strong> ${avg} mg/dL &nbsp; <strong>Max:</strong> ${lastReport.max_glucose} &nbsp; <strong>Min:</strong> ${lastReport.min_glucose}<br/>
    <strong>In Range:</strong> ${lastReport.in_range_pct}% &nbsp; <strong>Hypo Events:</strong> ${lastReport.hypo_events}<br/>
    <strong>Health Score:</strong> ${sc!==null?sc+'/100':'N/A'} &nbsp; <strong>Risk:</strong> ${risk.level}<br/>
    <strong>Steps Today:</strong> ${APP.steps.toLocaleString()} / ${lastReport.step_goal.toLocaleString()}<br/>
    <strong>Medications:</strong> ${lastReport.medications.join(', ')||'None'}<br/>
    <strong>Emergency Contacts:</strong> ${lastReport.emergency_contacts.join(', ')||'None'}
  </div>`;
  toast('Report generated!','ok');
}

function dlReport() {
  if (!lastReport) { toast('Generate a report first','warn'); return; }
  const blob = new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download='diabetrix_report_'+Date.now()+'.json'; a.click();
  URL.revokeObjectURL(url);
  toast('Report downloaded!','ok');
}

// ══════════════════════════════════════════
//  PROFILE
// ══════════════════════════════════════════
function saveProfile() {
  APP.profile = { ...APP.profile,
    name:      el('p-name').value.trim(),
    age:       el('p-age').value,
    gender:    el('p-gender').value,
    weight:    el('p-weight').value,
    height:    el('p-height').value,
    lifestyle: el('p-lifestyle').value,
    dtype:     el('p-dtype').value,
    year:      el('p-year').value,
    low:       el('p-low').value,
    high:      el('p-high').value,
    doc:       el('p-doc').value.trim(),
    allergies: el('p-allergies').value,
  };
  // Rebuild step goal and persist it
  const plan = buildPlan();
  APP.profile.stepGoal = plan.stepGoal;
  saveApp();
  const name = APP.profile.name;
  if (name) { if(el('dash-username')) el('dash-username').textContent=name.split(' ')[0]; el('sidebar-user').textContent='👤 '+name; }
  el('p-saved').classList.remove('hidden');
  setTimeout(()=>el('p-saved').classList.add('hidden'), 3000);
  toast('Profile saved! Plans updated.','ok');
}

// ══════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async ()=>{
  const token = sessionStorage.getItem('dbx_token');
  if (token) {
    APP.token = token;
    try {
      await loadAppFromServer();
      if (!APP.onboarded) startOnboarding();
      else startApp();
      return;
    } catch(e) {
      APP.token = null;
      sessionStorage.removeItem('dbx_token');
    }
  }
  el('screen-auth').classList.add('active');
});
