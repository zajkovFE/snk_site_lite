// =====================================================
//  Виртуальный пациент · API (подключается из worker.js, как tests.js)
//  GET  /api/simulation/templates          список (без диагноза)
//  GET  /api/simulation/template?id=...    паспорт поведения (без hidden_dx)
//  POST /api/simulation/submit             лог + история болезни -> оценка
//  GET  /api/simulation/results            свои результаты (админ: все)
//  PUT  /api/simulation/admin/template     админ: добавить/обновить паспорт
// =====================================================

const MAX_STUDENT_TURNS = 60;

// Допустимые диагнозы для выпадающего списка (МКБ-10, как в бланке истории болезни)
export const ICD10 = {
  "F20.0": "Параноидная шизофрения",
  "F25.0": "Шизоаффективное расстройство, маниакальный тип",
  "F30.2": "Маниакальный эпизод с психотическими симптомами",
  "F31.1": "Биполярное аффективное расстройство, текущий маниакальный эпизод",
  "F32.1": "Депрессивный эпизод средней тяжести",
  "F33.1": "Рекуррентное депрессивное расстройство, средний эпизод",
  "F40.1": "Социальные фобии",
  "F41.0": "Паническое расстройство",
  "F41.1": "Генерализованное тревожное расстройство",
  "F42.2": "Смешанные обсессивные мысли и действия (ОКР)",
  "F43.1": "Посттравматическое стрессовое расстройство",
  "F43.2": "Расстройство адаптации",
  "F45.0": "Соматизированное расстройство",
  "F45.2": "Ипохондрическое расстройство",
  "F45.3": "Соматоформная вегетативная дисфункция",
  "F50.0": "Нервная анорексия",
  "F50.2": "Нервная булимия",
  "F60.3": "Эмоционально неустойчивое расстройство личности",
};
const FIELDS = ["complaints", "anam_morbi", "anam_vitae", "somatic", "neuro", "mental_status", "justification", "differential", "plan"];
const REQUIRED = ["complaints", "anam_morbi", "anam_vitae", "mental_status", "justification", "differential"];

// Грубые реплики, нарушающие деонтологию: штраф за каждую (до 60 баллов)
const STOP_RE = [
  /вы\s+(всё|все)\s+придумыва/i, /вы\s+симулир/i, /проблемы\s+с\s+головой/i,
  /вы\s+псих/i, /вы\s+здоров/i, /ничего\s+у\s+вас\s+нет/i, /не\s+выдумывайте/i,
  /взять\s+себя\s+в\s+руки/i, /прекратите\s+ныть/i,
];

// Темы анамнеза: тема засчитывается, только если слово есть в ВОПРОСЕ студента
// (со знаком "?" или длиной >= 12), максимум одна тема на реплику — защита от «работа, семья, стресс».
const TOPICS = [
  ["триггеры", /работ|провер|ссор|конфликт|стресс|волнен|переживан/i],
  ["семья", /семь|муж|жена|дет[иь]|родител|мам|пап/i],
  ["сон", /\bсп(ите|ишь|ится)|сон\b|бессонн|засыпа/i],
  ["аппетит", /аппетит|ест[ье]|вес\b|питан/i],
  ["настроение", /настроени|депресс|тоск|подавлен|радост/i],
  ["суицид", /не\s+хочется\s+жить|мысл\w*\s+о\s+смерти|суицид|навредить\s+себе/i],
  ["обследования", /обследов|врач\w*\s+говор|кардиолог|экг|анализ|лечил|принима\w+\s+(препарат|лекарств)/i],
  ["начало", /когда\s+(это\s+)?(нача|появил)|как\s+давно|впервые/i],
  ["вредные привычки", /алкогол|курит|наркот|употребляе/i],
];

export async function handleSimulation(request, env, h) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/simulation")) return null;
  const m = request.method;
  const user = await h.getUser(request);
  const admin = await h.isAdmin(request);

  if (m === "GET" && path === "/api/simulation/icd") return h.json({ icd: ICD10 });

  if (m === "GET" && path === "/api/simulation/templates") {
    if (!user && !admin) return h.json({ error: "Нужен вход в кабинет" }, 401);
    const { results } = await env.DB.prepare("SELECT id, version, config_json FROM patient_templates WHERE active = 1 ORDER BY created_at").all();
    return h.json({ templates: results.map((r) => ({ id: r.id, version: r.version, meta: parse(r.config_json).meta || {} })) });
  }

  if (m === "GET" && path === "/api/simulation/template") {
    if (!user && !admin) return h.json({ error: "Нужен вход в кабинет" }, 401);
    const id = (url.searchParams.get("id") || "").slice(0, 80);
    const row = id
      ? await env.DB.prepare("SELECT * FROM patient_templates WHERE id = ? AND active = 1").bind(id).first()
      : await env.DB.prepare("SELECT * FROM patient_templates WHERE active = 1 ORDER BY RANDOM() LIMIT 1").first();
    if (!row) return h.json({ error: "Паспорт не найден" }, 404);
    // hidden_dx и syndrome_name наружу не уходят
    return h.json({ id: row.id, version: row.version, config: parse(row.config_json), limits: { maxTurns: 25, maxSeconds: 1200, ...(parse(row.config_json).limits || {}) } });
  }

  if (m === "POST" && path === "/api/simulation/submit") {
    if (!user) return h.json({ error: "Нужен вход в кабинет" }, 401);
    const b = await h.readJson(request);
    const tpl = await env.DB.prepare("SELECT * FROM patient_templates WHERE id = ?").bind(String(b.template_id || "")).first();
    if (!tpl) return h.json({ error: "Паспорт не найден" }, 404);
    const log = Array.isArray(b.chat_log) ? b.chat_log.slice(0, 200) : [];
    const turns = log.filter((x) => x && x.role === "student").map((x) => String(x.text || "").slice(0, 600)).slice(0, MAX_STUDENT_TURNS);
    if (!turns.length) return h.json({ error: "Пустой диалог" }, 400);
    const rep = b.report || {};
    const report = { diagnosis: String(rep.diagnosis || "").slice(0, 10) };
    for (const k of FIELDS) report[k] = String(rep[k] || "").slice(0, 3000);
    const scores = score(turns, report, tpl);
    const id = "sim_" + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare("INSERT INTO simulation_results (id, user_id, template_id, duration_seconds, chat_log, report_json, scores_json, total_score, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, user.id, tpl.id, Math.min(Number(b.duration_seconds) || 0, 86400), JSON.stringify(log), JSON.stringify(report), JSON.stringify(scores.parts), scores.total, Date.now()).run();
    // правильный диагноз показываем только после сдачи
    return h.json({ id, scores: scores.parts, total: scores.total, covered: scores.covered, correct_dx: tpl.hidden_dx, correct_name: ICD10[tpl.hidden_dx] || tpl.syndrome_name });
  }

  if (m === "GET" && path === "/api/simulation/results") {
    if (!user && !admin) return h.json({ error: "Нужен вход в кабинет" }, 401);
    const q = admin
      ? env.DB.prepare("SELECT r.id, r.user_id, u.name, r.template_id, r.duration_seconds, r.scores_json, r.total_score, r.created_at FROM simulation_results r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 500")
      : env.DB.prepare("SELECT id, template_id, duration_seconds, scores_json, total_score, created_at FROM simulation_results WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(user.id);
    const { results } = await q.all();
    return h.json({ results: results.map((r) => ({ ...r, scores: parse(r.scores_json), scores_json: undefined })) });
  }

  if (m === "PUT" && path === "/api/simulation/admin/template") {
    if (!admin) return h.json({ error: "Только администратор" }, 403);
    const b = await h.readJson(request);
    const id = String(b.id || "").replace(/[^a-z0-9-]/gi, "").slice(0, 60);
    if (!id || !b.config || !ICD10[b.hidden_dx]) return h.json({ error: "Нужны id, config и hidden_dx из списка МКБ-11" }, 400);
    await env.DB.prepare("INSERT INTO patient_templates (id, version, syndrome_name, hidden_dx, config_json, active, created_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT (id) DO UPDATE SET version = version + 1, syndrome_name = excluded.syndrome_name, hidden_dx = excluded.hidden_dx, config_json = excluded.config_json, active = excluded.active")
      .bind(id, 1, String(b.syndrome_name || ICD10[b.hidden_dx]).slice(0, 200), b.hidden_dx, JSON.stringify(b.config), Date.now()).run();
    return h.json({ ok: true, id });
  }

  return h.json({ error: "not found" }, 404);
}

function parse(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

function score(turns, report, tpl) {
  // 1. Деонтология: 100, минус 20 за каждую грубую реплику
  const hits = turns.filter((t) => STOP_RE.some((re) => re.test(t))).length;
  const deontology = Math.max(0, 100 - hits * 20);

  // 2. Диагноз: полный балл за точный код, половина за ту же группу (первые 3 символа)
  const dx = report.diagnosis, hid = tpl.hidden_dx;
  const diagnostic = dx === hid ? 100 : dx && dx.slice(0, 3) === hid.slice(0, 3) ? 50 : 0;

  // 3. Анамнез: засчитываются только вопросы, одна тема на реплику
  const covered = new Set();
  for (const t of turns) {
    if (!(t.includes("?") || t.length >= 12)) continue;
    const topic = TOPICS.find(([name, re]) => !covered.has(name) && re.test(t));
    if (topic) covered.add(topic[0]);
  }
  const history = Math.min(100, Math.round((covered.size / 6) * 100)); // 6 тем из 9 = максимум

  // 4. Заполненность истории болезни
  const filled = REQUIRED.filter((k) => (report[k] || "").trim().length >= 30).length;
  const completeness = Math.round((filled / REQUIRED.length) * 100);

  const parts = { deontology, diagnostic_accuracy: diagnostic, history_taking: history, completeness };
  const total = Math.round(deontology * 0.2 + diagnostic * 0.4 + history * 0.25 + completeness * 0.15);
  return { parts, total, covered: [...covered] };
}
