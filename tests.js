// tests.js — модуль опросников для snk-api (Cloudflare Worker + D1).
// Подключение в worker.js: см. комментарий в конце файла.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEF = 800000;   // байт, размер JSON шаблона (MMPI-566 с запасом)
const MAX_BODY = 65536;   // байт, размер ответа респондента
const MAX_ROWS = 5000;

// Стандартное информационное согласие. {topic} и {contacts} подставляются из настроек исследователя.
export const STD_CONSENT = [
  'Наше исследование проводится в рамках изучения {topic}.',
  'Участие добровольное. Вы можете прекратить прохождение в любой момент без объяснения причин и без каких-либо последствий.',
  'Опрос анонимный: имя, IP-адрес и точное время прохождения не сохраняются. Ответы используются только в научных целях и публикуются в обобщённом виде.',
  'Результат скрининга не является диагнозом. Если вас что-то беспокоит, обратитесь к специалисту.',
  '{result}',
  'После прохождения вы получите номер участника: по нему можно отозвать свои ответы.',
  'По всем вопросам вы можете обратиться к исследователям: {contacts}',
].join('\n\n');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = (v) => Math.round(v * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ====================== ПРОВЕРКА И НОРМАЛИЗАЦИЯ ШАБЛОНА ====================== */

function normOptions(list, where, errs) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 12) {
    errs.push(`${where}: нужно от 2 до 12 вариантов ответа`);
    return null;
  }
  const out = [];
  list.forEach((o, i) => {
    const t = typeof o === 'string' ? o : o && o.t;
    const v = typeof o === 'string' ? i : o && o.v;
    if (typeof t !== 'string' || !t.trim()) errs.push(`${where}, вариант ${i + 1}: пустой текст (поле t)`);
    else if (!isNum(v)) errs.push(`${where}, вариант ${i + 1}: значение v должно быть числом`);
    else out.push({ t: t.trim().slice(0, 300), v });
  });
  return out.length === list.length ? out : null;
}

function normBands(bands, where, errs) {
  if (bands === undefined) return [];
  if (!Array.isArray(bands)) { errs.push(`${where}: bands должен быть массивом`); return []; }
  const out = []; let prev = -Infinity;
  bands.forEach((b, i) => {
    const label = str(b && b.label, 200);
    if (!label) errs.push(`${where}, bands[${i}]: нет label`);
    if (b && b.max !== undefined) {
      if (!isNum(b.max)) errs.push(`${where}, bands[${i}]: max должен быть числом`);
      else if (b.max < prev) errs.push(`${where}, bands[${i}]: max должен идти по возрастанию`);
      else prev = b.max;
    } else if (i !== bands.length - 1) errs.push(`${where}, bands[${i}]: диапазон без max допустим только последним`);
    out.push({ max: b && isNum(b.max) ? b.max : null, label });
  });
  return out;
}

export function validateDefinition(d) {
  const errs = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { errors: ['JSON должен быть объектом'], def: null };

  const slug = String(d.slug || '');
  if (!SLUG_RE.test(slug)) errs.push('slug: латиница в нижнем регистре, цифры и дефис, 2–41 символ (например ssd-12)');
  const title = str(d.title, 200);
  if (!title) errs.push('title: обязательное поле');

  const sets = {};
  if (d.option_sets !== undefined) {
    if (typeof d.option_sets !== 'object' || Array.isArray(d.option_sets)) errs.push('option_sets: должен быть объектом');
    else for (const [k, v] of Object.entries(d.option_sets)) { const o = normOptions(v, `option_sets.${k}`, errs); if (o) sets[k] = o; }
  }

  const items = []; const seen = new Set();
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 700) errs.push('items: нужен массив из 1–700 вопросов');
  else d.items.forEach((it, n) => {
    const w = `items[${n}]`;
    if (!it || typeof it !== 'object') { errs.push(`${w}: должен быть объектом`); return; }
    if (!ID_RE.test(String(it.id || ''))) { errs.push(`${w}: id — латиница/цифры/._-, до 40 символов`); return; }
    if (seen.has(it.id)) { errs.push(`${w}: повторяющийся id «${it.id}»`); return; }
    seen.add(it.id);
    const text = str(it.text, 1500);
    if (!text) errs.push(`${w} (${it.id}): нет text`);
    let options = null;
    if (Array.isArray(it.options)) options = normOptions(it.options, `${w} (${it.id})`, errs);
    else if (it.set && sets[it.set]) options = sets[it.set];
    else errs.push(`${w} (${it.id}): нужны options или set из option_sets`);
    let show_if = null;
    if (it.show_if !== undefined) {
      const s = it.show_if;
      if (!s || !seen.has(s.item) || s.item === it.id || !Array.isArray(s.in) || !s.in.every(Number.isInteger))
        errs.push(`${w} (${it.id}): show_if = {item: "<id более раннего вопроса>", in: [номера вариантов с 0]}`);
      else show_if = { item: s.item, in: s.in };
    }
    items.push({
      id: it.id, text, options: options || [],
      section: str(it.section, 200) || undefined,
      reverse: !!it.reverse, scored: it.scored !== false, required: it.required !== false, show_if,
    });
  });

  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const subs = []; const sc = d.scoring || {};
  if (sc.subscales !== undefined && !Array.isArray(sc.subscales)) errs.push('scoring.subscales: должен быть массивом');
  else (sc.subscales || []).forEach((s, n) => {
    const w = `scoring.subscales[${n}]`;
    if (!s || !ID_RE.test(String(s.id || ''))) { errs.push(`${w}: нужен id`); return; }
    if (subs.some((x) => x.id === s.id)) { errs.push(`${w}: повторяющийся id «${s.id}»`); return; }
    if (s.derive !== undefined) {   // производная шкала: взвешенная сумма уже вычисленных (например Hs + 0.5K)
      if (!Array.isArray(s.derive) || !s.derive.length) { errs.push(`${w} (${s.id}): derive — непустой массив [{scale, w}]`); return; }
      const parts = [];
      for (const q of s.derive) {
        if (!q || !subs.some((x) => x.id === q.scale) || !isNum(q.w)) errs.push(`${w} (${s.id}): derive — {scale: "id субшкалы, заданной выше", w: число}`);
        else parts.push({ scale: q.scale, w: q.w });
      }
      subs.push({ id: s.id, name: str(s.name, 200) || s.id, derive: parts, round: !!s.round, bands: normBands(s.bands, `${w} (${s.id})`, errs) });
      return;
    }
    let list = s.items;
    if (list === '*') list = '*';
    else if (!Array.isArray(list) || !list.length) { errs.push(`${w} (${s.id}): items — массив id вопросов или "*"`); return; }
    else for (const id of list) if (!byId[id]) errs.push(`${w} (${s.id}): вопроса «${id}» нет в items`); else if (!byId[id].scored) errs.push(`${w} (${s.id}): вопрос «${id}» помечен scored:false`);
    let rev = [];
    if (s.reverse_items !== undefined) {   // обратный ключ только внутри этой шкалы (MMPI: «верно» в одной шкале, «неверно» в другой)
      if (!Array.isArray(s.reverse_items) || s.reverse_items.some((id) => !byId[id] || (Array.isArray(list) && !list.includes(id)))) errs.push(`${w} (${s.id}): reverse_items — id вопросов из этой же шкалы`);
      else rev = s.reverse_items;
    }
    const method = s.method === 'mean' ? 'mean' : 'sum';
    if (s.method && !['sum', 'mean'].includes(s.method)) errs.push(`${w} (${s.id}): method — sum или mean`);
    const ma = s.min_answered === undefined ? 1 : s.min_answered;
    if (!isNum(ma) || ma < 0 || ma > 1) errs.push(`${w} (${s.id}): min_answered — число от 0 до 1`);
    subs.push({ id: s.id, name: str(s.name, 200) || s.id, items: list, reverse_items: rev, method, min_answered: isNum(ma) ? ma : 1, bands: normBands(s.bands, `${w} (${s.id})`, errs) });
  });

  let axes = null;
  if (d.axes !== undefined) {
    axes = { x: {}, y: {} };
    for (const ax of ['x', 'y']) {
      const wts = d.axes[ax] && d.axes[ax].weights;
      if (!wts || typeof wts !== 'object') { errs.push(`axes.${ax}.weights: нужен объект {id_субшкалы: вес}`); continue; }
      for (const [k, v] of Object.entries(wts)) {
        if (!subs.some((s) => s.id === k)) errs.push(`axes.${ax}.weights: субшкалы «${k}» нет в scoring.subscales`);
        else if (!isNum(v) || Math.abs(v) > 10) errs.push(`axes.${ax}.weights.${k}: вес — число от -10 до 10`);
        else axes[ax][k] = v;
      }
    }
  }

  const safety = [];
  if (d.safety !== undefined) {
    if (!Array.isArray(d.safety)) errs.push('safety: должен быть массивом');
    else d.safety.forEach((r, n) => {
      if (!r || !byId[r.item] || !isNum(r.gt) || !str(r.message, 1500)) errs.push(`safety[${n}]: нужны item (id вопроса), gt (число) и message`);
      else safety.push({ item: r.item, gt: r.gt, message: str(r.message, 1500) });
    });
  }

  const ps = d.page_size === undefined ? 5 : d.page_size;
  if (!Number.isInteger(ps) || ps < 1 || ps > 20) errs.push('page_size: целое от 1 до 20');

  if (errs.length) return { errors: errs, def: null };
  const def = {
    slug, title, topic: str(d.topic, 300),
    description: str(d.description, 1000), instructions: str(d.instructions, 3000),
    consent: str(d.consent, 5000), consent_label: str(d.consent_label, 300) || 'Я прочитал(а) информацию и согласен(на) участвовать',
    result_note: str(d.result_note, 2000), show_scores: d.show_scores !== false, page_size: ps,
    items, scoring: { subscales: subs }, axes, safety,
  };
  if (JSON.stringify(def).length > MAX_DEF) return { errors: ['шаблон слишком большой (больше 800 КБ)'], def: null };
  return { errors: [], def };
}

/* ====================== ПОДСЧЁТ ====================== */

export function computeResult(def, answers) {
  const errors = []; const idx = {}; const vis = {}; const raw = {}; const val = {};
  const range = {};
  for (const it of def.items) {
    const vs = it.options.map((o) => o.v);
    range[it.id] = [Math.min(...vs), Math.max(...vs)];
    let visible = true;
    if (it.show_if) visible = !!vis[it.show_if.item] && idx[it.show_if.item] !== undefined && it.show_if.in.includes(idx[it.show_if.item]);
    vis[it.id] = visible;
    if (!visible) continue;
    const a = answers[it.id];
    if (a === undefined || a === null) { if (it.required) errors.push(it.id); continue; }
    if (!Number.isInteger(a) || a < 0 || a >= it.options.length) { errors.push(it.id); continue; }
    idx[it.id] = a; raw[it.id] = it.options[a].v;
    val[it.id] = it.reverse ? range[it.id][0] + range[it.id][1] - raw[it.id] : raw[it.id];
  }
  if (errors.length) return { errors };

  const scores = {}; const normRaw = {}; const rng = {};
  const bandOf = (sub, score) => { const b = sub.bands.find((x) => x.max === null || score <= x.max); return b ? b.label : null; };
  for (const s of def.scoring.subscales) {
    if (s.derive) {
      const lo = s.derive.reduce((a, q) => a + (q.w >= 0 ? q.w * rng[q.scale][0] : q.w * rng[q.scale][1]), 0);
      const hi = s.derive.reduce((a, q) => a + (q.w >= 0 ? q.w * rng[q.scale][1] : q.w * rng[q.scale][0]), 0);
      rng[s.id] = [lo, hi];
      let score = null, norm = null, band = null;
      if (s.derive.every((q) => scores[q.scale].score !== null)) {
        const raw = s.derive.reduce((a, q) => a + q.w * scores[q.scale].score, 0);
        score = s.round ? Math.round(raw) : r2(raw);
        norm = hi > lo ? clamp((score - lo) / (hi - lo), 0, 1) : 0; normRaw[s.id] = norm; norm = r2(norm);
        band = bandOf(s, score);
      }
      scores[s.id] = { score, band, norm };
      continue;
    }
    const ids = (s.items === '*' ? def.items.filter((i) => i.scored).map((i) => i.id) : s.items).filter((id) => vis[id]);
    const ans = ids.filter((id) => id in val);
    const flip = (id) => (s.reverse_items.includes(id) ? range[id][0] + range[id][1] - val[id] : val[id]);
    const lo = ids.reduce((a, id) => a + range[id][0], 0), hi = ids.reduce((a, id) => a + range[id][1], 0), k = ids.length || 1;
    rng[s.id] = s.method === 'mean' ? [lo / k, hi / k] : [lo, hi];
    let score = null, norm = null, band = null;
    if (ans.length && ans.length / ids.length >= s.min_answered) {
      const sum = ans.reduce((a, id) => a + flip(id), 0);
      if (s.method === 'mean') score = r2(sum / ans.length);
      else score = r2(sum * ids.length / ans.length); // пропорциональная экстраполяция при пропусках
      const [l, h] = rng[s.id];
      norm = h > l ? clamp((score - l) / (h - l), 0, 1) : 0; normRaw[s.id] = norm; norm = r2(norm);
      band = bandOf(s, score);
    }
    scores[s.id] = { score, band, norm };
  }

  let x = null, y = null;
  if (def.axes) {
    const proj = (w) => r2(clamp(Object.entries(w).reduce((a, [k, wt]) => a + (normRaw[k] !== undefined ? wt * normRaw[k] : 0), 0), -10, 10));
    x = proj(def.axes.x); y = proj(def.axes.y);
  }
  const safety = def.safety.filter((r) => vis[r.item] && raw[r.item] !== undefined && raw[r.item] > r.gt).map((r) => r.message);
  return { errors: [], raw, scores, x, y, safety };
}

/* ====================== ВСПОМОГАТЕЛЬНОЕ ====================== */

async function sha256hex(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// Публичный вид шаблона для респондента: без ключей подсчёта, осей и правил безопасности.
const resultLine = (def, cfg) => (cfg && cfg.show_result && def.show_scores)
  ? 'После прохождения вы увидите свой результат.' : 'Индивидуальный результат после прохождения показан не будет.';
function buildConsent(def, cfg) {
  const none = 'контактные данные исследователем не указаны', rl = resultLine(def, cfg);
  if (cfg && cfg.mode === 'custom') return cfg.custom_text + '\n\n' + rl + '\n\nКонтакты исследователя: ' + (cfg.contacts || 'не указаны.');
  if (cfg) return STD_CONSENT.replace('{topic}', () => cfg.topic || def.topic || def.title).replace('{result}', () => rl).replace('{contacts}', () => cfg.contacts || none);
  if (def.consent) return def.consent + '\n\n' + rl + '\n\nКонтактные данные исследователя не указаны.';
  return STD_CONSENT.replace('{topic}', () => def.topic || def.title).replace('{result}', () => rl).replace('{contacts}', () => 'контактные данные не указаны');
}
const latestConfig = (db, login, slug) => db.prepare('SELECT * FROM study_configs WHERE login = ? AND slug = ? ORDER BY id DESC LIMIT 1').bind(login, slug).first();

function publicView(row, def, consent, configId, contacts) {
  return {
    slug: def.slug, title: def.title, version: row.version, description: def.description, instructions: def.instructions,
    consent, config_id: configId || null, contacts: contacts || '', consent_label: def.consent_label, page_size: def.page_size,
    items: def.items.map((i) => ({ id: i.id, text: i.text, section: i.section, required: i.required, show_if: i.show_if, options: i.options.map((o) => o.t) })),
  };
}

/* ====================== ОБРАБОТЧИК ====================== */
// ctx = { json(data, status), text(body, status, contentType, extraHeaders), isAdmin(request) -> bool, getUser(request) -> {login,...}|null }

export async function handleTests(request, env, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/tests')) return null;
  const method = request.method;
  if (method === 'OPTIONS') return ctx.json({}, 204);
  const parts = url.pathname.replace(/\/+$/, '').split('/').slice(3); // после /api/tests
  const db = env.DB;
  const err = (m, s = 400, extra = {}) => ctx.json({ error: m, ...extra }, s);
  const readJson = async (max) => {
    const t = await request.text();
    if (t.length > max) throw new Error('Слишком большой запрос');
    try { return JSON.parse(t); } catch (e) { throw new Error('Некорректный JSON'); }
  };

  try {
    /* ---- публичные: список и шаблон для респондента ---- */
    if (method === 'GET' && parts[0] === 'templates') {
      const admin = await ctx.isAdmin(request);
      if (!parts[1]) {
        if (url.searchParams.get('all') === '1') {
          if (!admin) return err('Только для администратора', 403);
          const { results } = await db.prepare(
            `SELECT t.id, t.slug, t.version, t.title, t.status, t.created_at, t.updated_at,
                    (SELECT COUNT(*) FROM test_results r WHERE r.template_id = t.id) AS n
             FROM test_templates t ORDER BY t.slug, t.version DESC`).all();
          return ctx.json({ templates: results });
        }
        const { results } = await db.prepare(`SELECT slug, version, title, definition FROM test_templates WHERE status = 'active' ORDER BY title`).all();
        return ctx.json({ tests: results.map((r) => { const d = JSON.parse(r.definition); return { slug: r.slug, version: r.version, title: r.title, description: d.description, topic: d.topic, show_scores: !!d.show_scores, items: d.items.length }; }) });
      }
      const slug = parts[1];
      if (url.searchParams.get('full') === '1') {
        if (!admin) return err('Только для администратора', 403);
        const id = Number(url.searchParams.get('id'));
        const row = id ? await db.prepare('SELECT * FROM test_templates WHERE id = ?').bind(id).first()
          : await db.prepare(`SELECT * FROM test_templates WHERE slug = ? ORDER BY version DESC LIMIT 1`).bind(slug).first();
        if (!row) return err('Шаблон не найден', 404);
        return ctx.json({ id: row.id, version: row.version, status: row.status, definition: JSON.parse(row.definition) });
      }
      const row = await db.prepare(`SELECT * FROM test_templates WHERE slug = ? AND status = 'active' ORDER BY version DESC LIMIT 1`).bind(slug).first();
      if (!row) return err('Опросник не найден или отключён', 404);
      const def = JSON.parse(row.definition);
      const ref = str(url.searchParams.get('ref'), 80).toLowerCase(); let cfg = null;
      if (ref) { const u = await db.prepare(`SELECT login FROM users WHERE login = ? AND status = 'active'`).bind(ref).first(); if (u) cfg = await latestConfig(db, u.login, slug); }
      return ctx.json({ test: publicView(row, def, buildConsent(def, cfg), cfg && cfg.id, cfg ? cfg.contacts : '') });
    }

    /* ---- админ: загрузка шаблона ---- */
    if (method === 'POST' && parts[0] === 'templates' && !parts[1]) {
      if (!(await ctx.isAdmin(request))) return err('Только для администратора', 403);
      let body; try { body = await readJson(MAX_DEF + 1000); } catch (e) { return err(e.message); }
      const publish = body && body.publish === false ? false : true;
      const { errors, def } = validateDefinition(body);
      if (errors.length) return err('Шаблон не прошёл проверку', 400, { details: errors });
      const last = await db.prepare('SELECT version, definition FROM test_templates WHERE slug = ? ORDER BY version DESC LIMIT 1').bind(def.slug).first();
      const json = JSON.stringify(def);
      if (last && last.definition === json) return err('Такой шаблон уже загружен (изменений нет)', 409);
      const version = last ? last.version + 1 : 1;
      if (publish) await db.prepare(`UPDATE test_templates SET status = 'archived', updated_at = datetime('now') WHERE slug = ? AND status = 'active'`).bind(def.slug).run();
      const r = await db.prepare('INSERT INTO test_templates (slug, version, title, status, definition) VALUES (?, ?, ?, ?, ?)')
        .bind(def.slug, version, def.title, publish ? 'active' : 'draft', json).run();
      return ctx.json({ ok: true, id: r.meta.last_row_id, slug: def.slug, version, status: publish ? 'active' : 'draft' }, 201);
    }

    if (method === 'POST' && parts[0] === 'templates' && parts[2] === 'status') {
      if (!(await ctx.isAdmin(request))) return err('Только для администратора', 403);
      const id = Number(parts[1]); let body; try { body = await readJson(1000); } catch (e) { return err(e.message); }
      if (!['draft', 'active', 'archived'].includes(body.status)) return err('status: draft, active или archived');
      const row = await db.prepare('SELECT slug FROM test_templates WHERE id = ?').bind(id).first();
      if (!row) return err('Шаблон не найден', 404);
      if (body.status === 'active') await db.prepare(`UPDATE test_templates SET status = 'archived' WHERE slug = ? AND status = 'active'`).bind(row.slug).run();
      await db.prepare(`UPDATE test_templates SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.status, id).run();
      return ctx.json({ ok: true });
    }

    if (method === 'DELETE' && parts[0] === 'templates' && parts[1]) {
      if (!(await ctx.isAdmin(request))) return err('Только для администратора', 403);
      const id = Number(parts[1]);
      const n = (await db.prepare('SELECT COUNT(*) AS n FROM test_results WHERE template_id = ?').bind(id).first()).n;
      if (n && url.searchParams.get('force') !== '1') return err(`У версии есть ответы (${n}). Удаление сотрёт и их.`, 409, { results: n });
      await db.prepare('DELETE FROM test_results WHERE template_id = ?').bind(id).run();
      await db.prepare('DELETE FROM test_templates WHERE id = ?').bind(id).run();
      return ctx.json({ ok: true });
    }

    /* ---- студент: информированное согласие и контакты исследователя ---- */
    if (parts[0] === 'config') {
      const user = await ctx.getUser(request);
      if (!user) return err('Войдите в аккаунт студента', 401);
      if (method === 'GET' && !parts[1]) {
        const { results } = await db.prepare(`SELECT c.* FROM study_configs c WHERE c.login = ? AND c.id = (SELECT MAX(id) FROM study_configs WHERE login = c.login AND slug = c.slug)`).bind(user.login).all();
        return ctx.json({ std: STD_CONSENT, configs: Object.fromEntries(results.map((c) => [c.slug, { id: c.id, mode: c.mode, topic: c.topic, custom_text: c.custom_text, contacts: c.contacts, no_contacts: !!c.no_contacts, show_result: !!c.show_result, created_at: c.created_at }])) });
      }
      if (method === 'POST' && parts[1]) {
        const slug = parts[1];
        const tpl = await db.prepare(`SELECT id, definition FROM test_templates WHERE slug = ? AND status = 'active' ORDER BY version DESC LIMIT 1`).bind(slug).first();
        if (!tpl) return err('Опросник не найден или отключён', 404);
        let b; try { b = await readJson(20000); } catch (e) { return err(e.message); }
        const mode = b.mode === 'custom' ? 'custom' : 'standard';
        const contacts = str(b.contacts, 500), topic = str(b.topic, 300), custom = str(b.custom_text, 5000);
        if (mode === 'standard' && !topic) return err('Укажите, в рамках изучения чего проводится исследование');
        if (mode === 'custom' && custom.length < 30) return err('Текст согласия слишком короткий (минимум 30 знаков)');
        if (!contacts && b.no_contacts !== true) return err('Укажите контакты исследователя или подтвердите, что работаете без них');
        let allowShow = false; try { allowShow = !!JSON.parse(tpl.definition).show_scores; } catch (e) {}
        const showResult = b.show_result === true && allowShow ? 1 : 0; // результат показываем только если исследователь отметил и шкала это допускает
        const r = await db.prepare('INSERT INTO study_configs (login, slug, mode, topic, custom_text, contacts, no_contacts, show_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(user.login, slug, mode, mode === 'standard' ? topic : '', mode === 'custom' ? custom : '', contacts, contacts ? 0 : 1, showResult).run();
        return ctx.json({ ok: true, id: r.meta.last_row_id }, 201);
      }
      return err('Не найдено', 404);
    }

    /* ---- респондент: приём ответов (анонимно) ---- */
    if (method === 'POST' && parts[0] === 'submit') {
      let body; try { body = await readJson(MAX_BODY); } catch (e) { return err(e.message); }
      if (!body || !SLUG_RE.test(String(body.slug || '')) || !UUID_RE.test(String(body.id || '')) || typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers))
        return err('Некорректный запрос');
      const row = await db.prepare(`SELECT * FROM test_templates WHERE slug = ? AND status = 'active' ORDER BY version DESC LIMIT 1`).bind(body.slug).first();
      if (!row) return err('Опросник не найден или отключён', 404);
      const def = JSON.parse(row.definition);
      const res = computeResult(def, body.answers);
      if (res.errors.length) return err('Ответьте на все обязательные вопросы', 400, { missing: res.errors });

      // ref -> researcher_token: только существующий активный студент, иначе без привязки
      let token = null; const ref = str(body.ref, 80).toLowerCase();
      if (ref) { const u = await db.prepare(`SELECT login FROM users WHERE login = ? AND status = 'active'`).bind(ref).first(); if (u) token = u.login; }
      let cfgId = null, showRes = false;
      if (token && Number.isInteger(body.config_id)) { const c = await db.prepare('SELECT id, show_result FROM study_configs WHERE id = ? AND login = ? AND slug = ?').bind(body.config_id, token, row.slug).first(); if (c) { cfgId = c.id; showRes = !!c.show_result; } }
      let dur = Number.isInteger(body.duration_sec) ? clamp(body.duration_sec, 0, 86400) : null;
      const day = new Date().toISOString().slice(0, 10);
      await db.prepare(`INSERT OR IGNORE INTO test_results (id, template_id, slug, version, researcher_token, answers, scores, coord_x, coord_y, duration_sec, day, config_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(body.id.toLowerCase(), row.id, row.slug, row.version, token, JSON.stringify(res.raw), JSON.stringify(res.scores), res.x, res.y, dur, day, cfgId).run();
      const out = { ok: true, id: body.id.toLowerCase(), safety: res.safety }; // сообщение безопасности показываем всегда
      if (def.show_scores && showRes) { out.scores = def.scoring.subscales.map((s) => ({ id: s.id, name: s.name, ...res.scores[s.id] })); out.note = def.result_note; }
      else out.result_hidden = true;
      return ctx.json(out, 201);
    }

    if (method === 'POST' && parts[0] === 'withdraw') {
      let body; try { body = await readJson(1000); } catch (e) { return err(e.message); }
      if (!UUID_RE.test(String(body.id || ''))) return err('Некорректный номер участника');
      const r = await db.prepare('DELETE FROM test_results WHERE id = ?').bind(String(body.id).toLowerCase()).run();
      return ctx.json({ ok: true, deleted: r.meta.changes || 0 });
    }

    /* ---- студент / админ: результаты ---- */
    if (method === 'GET' && (parts[0] === 'results' || parts[0] === 'summary')) {
      const admin = await ctx.isAdmin(request);
      const user = admin ? null : await ctx.getUser(request);
      if (!admin && !user) return err('Требуется вход', 401);
      const scope = admin ? '' : ' AND r.researcher_token = ?';
      const bindScope = admin ? [] : [user.login];

      if (parts[0] === 'summary') {
        const { results } = await db.prepare(
          `SELECT r.slug, MAX(t.title) AS title, COUNT(*) AS n FROM test_results r JOIN test_templates t ON t.id = r.template_id
           WHERE 1=1${scope} GROUP BY r.slug ORDER BY r.slug`).bind(...bindScope).all();
        return ctx.json({ summary: results });
      }

      const slug = url.searchParams.get('slug') || '';
      const ref = admin ? (url.searchParams.get('ref') || '') : '';
      let q = `SELECT r.id, r.slug, r.version, r.researcher_token, r.answers, r.scores, r.coord_x, r.coord_y, r.duration_sec, r.config_id, r.day, t.title
               FROM test_results r JOIN test_templates t ON t.id = r.template_id WHERE 1=1${scope}`;
      const b = [...bindScope];
      if (slug) { q += ' AND r.slug = ?'; b.push(slug); }
      if (ref) { q += ' AND r.researcher_token = ?'; b.push(ref); }
      q += ` ORDER BY r.day, r.rowid LIMIT ${MAX_ROWS}`;
      const { results: rows } = await db.prepare(q).bind(...b).all();

      if (url.searchParams.get('format') === 'csv') {
        const aKeys = [], sKeys = []; const parsed = rows.map((r) => ({ r, a: JSON.parse(r.answers), s: JSON.parse(r.scores) }));
        for (const p of parsed) { for (const k of Object.keys(p.a)) if (!aKeys.includes(k)) aKeys.push(k); for (const k of Object.keys(p.s)) if (!sKeys.includes(k)) sKeys.push(k); }
        const head = ['id', 'test', 'version', 'day', ...(admin ? ['researcher'] : []), 'duration_sec', 'consent_v', ...aKeys, ...sKeys.map((k) => 'score_' + k), 'coord_x', 'coord_y'];
        const lines = [head.map(csvCell).join(';')];
        for (const { r, a, s } of parsed)
          lines.push([r.id, r.slug, r.version, r.day, ...(admin ? [r.researcher_token] : []), r.duration_sec, r.config_id,
            ...aKeys.map((k) => a[k]), ...sKeys.map((k) => (s[k] ? s[k].score : '')), r.coord_x, r.coord_y].map(csvCell).join(';'));
        return ctx.text('\uFEFF' + lines.join('\r\n'), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${slug || 'tests'}.csv"` });
      }
      let scales = [], hasAxes = false;
      if (slug) {
        const t = await db.prepare('SELECT definition FROM test_templates WHERE slug = ? ORDER BY version DESC LIMIT 1').bind(slug).first();
        if (t) { const d = JSON.parse(t.definition); scales = d.scoring.subscales.map((x) => ({ id: x.id, name: x.name })); hasAxes = !!d.axes; }
      }
      return ctx.json({
        total: rows.length, scales, has_axes: hasAxes,
        results: rows.map((r) => ({
          id: r.id, test_name: r.title, slug: r.slug, version: r.version, day: r.day,
          x: r.coord_x, y: r.coord_y, scores: JSON.parse(r.scores), ...(admin ? { researcher: r.researcher_token } : {}),
        })),
      });
    }

    return err('Не найдено', 404);
  } catch (e) {
    return err('Ошибка сервера: ' + (e && e.message ? e.message : e), 500);
  }
}
