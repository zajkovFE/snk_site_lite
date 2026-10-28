// =====================================================
//  СНК · API для файлов (Cloudflare Worker + R2 + D1)
//  Вставляется целиком в редактор Worker'а. Ничего больше менять не нужно,
//  кроме строки ALLOWED_ORIGIN (когда сайт будет на GitHub Pages).
// =====================================================

// "*" = принимать запросы с любого сайта (удобно для тестов).
// Когда сайт будет опубликован, замените на адрес вида "https://ВАШ-ЛОГИН.github.io"
const ALLOWED_ORIGIN = "*";

// Максимальный размер одного файла (бесплатный план Workers пропускает ~100 МБ на запрос)
const MAX_FILE_BYTES = 90 * 1024 * 1024;

// Эти типы открываются прямо в браузере. Всё остальное отдаётся как скачивание
// (так безопаснее: чужой HTML/SVG не сможет выполниться на нашем домене).
const INLINE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
];

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const m = request.method;

      if (m === "GET" && path === "/") return json({ ok: true, service: "snk-api" });
      if (m === "GET" && path === "/api/whoami") return json({ role: await getRole(request, env) });
      if (m === "GET" && path === "/api/list") return await listItems(url, env);
      if (m === "POST" && path === "/api/items") return await createItem(request, url, env);
      if (m === "GET" && path.startsWith("/api/file/")) return await getFile(request, path, env);
      if (m === "DELETE" && path.startsWith("/api/items/")) return await deleteItem(request, path, env);

      if (["/api/register", "/api/login", "/api/me", "/api/works", "/api/users", "/api/members"].some((p) => path === p || path.startsWith(p + "/"))) {
        return await accountRoutes(request, url, env);
      }
      if (path === "/api/interviews" || path.startsWith("/api/interviews/")) return await interviewRoutes(request, url, env);
      if (path.startsWith("/api/state/")) {
        if (m === "GET") return await getState(path, env);
        if (m === "PUT") return await putState(request, path, env);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server error", detail: String(e) }, 500);
    }
  },
};

// ---------- вспомогательное ----------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Password, X-Token, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Возвращает "admin", "member" (общий пароль), "user" (участник с токеном) или null
async function getRole(request, env) {
  const pw = request.headers.get("X-Password") || "";
  if (pw) {
    if (env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD)) return "admin";
    if (env.UPLOAD_PASSWORD && safeEqual(pw, env.UPLOAD_PASSWORD)) return "member";
    return null;
  }
  return (await getUser(request, env)) ? "user" : null;
}

async function getUser(request, env) {
  const t = request.headers.get("X-Token") || "";
  if (!t) return null;
  return await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'"
  ).bind(await sha256(t), Date.now()).first();
}

function clean(s, max) {
  return (s || "").toString().trim().slice(0, max);
}

function safeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

// ---------- список ----------

async function listItems(url, env) {
  const kind = clean(url.searchParams.get("kind"), 40);
  const stmt = kind
    ? env.DB.prepare("SELECT * FROM items WHERE kind = ? ORDER BY created_at DESC LIMIT 500").bind(kind)
    : env.DB.prepare("SELECT * FROM items ORDER BY created_at DESC LIMIT 500");
  const { results } = await stmt.all();
  const items = results.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    meta: safeParse(r.meta),
    fileName: r.file_name,
    mime: r.mime,
    size: r.size,
    createdAt: r.created_at,
    fileUrl: r.file_key ? `${url.origin}/api/file/${r.file_key}` : null,
  }));
  return json({ items });
}

// ---------- создание (файл необязателен) ----------
// POST /api/items?kind=science&title=...&filename=...&meta={"author":"..."}
// Тело запроса = сам файл (или пустое, если файла нет).

async function createItem(request, url, env) {
  if (!(await getRole(request, env))) return json({ error: "wrong password" }, 401);

  const kind = clean(url.searchParams.get("kind"), 40);
  const title = clean(url.searchParams.get("title"), 300);
  if (!kind || !title) return json({ error: "kind and title are required" }, 400);

  let meta = {};
  try { meta = JSON.parse(url.searchParams.get("meta") || "{}"); }
  catch { return json({ error: "bad meta json" }, 400); }
  const metaStr = JSON.stringify(meta);
  if (metaStr.length > 5000) return json({ error: "meta too long" }, 400);

  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (len > MAX_FILE_BYTES) return json({ error: "file too large" }, 413);

  const id = crypto.randomUUID();
  let fileKey = null, fileName = null, mime = null;

  if (len > 0 && request.body) {
    fileName = clean(url.searchParams.get("filename"), 200) || "file";
    mime = (request.headers.get("Content-Type") || "application/octet-stream")
      .split(";")[0].trim().toLowerCase();
    fileKey = id;
    await env.BUCKET.put(fileKey, request.body, { httpMetadata: { contentType: mime } });
  }

  await env.DB.prepare(
    "INSERT INTO items (id, kind, title, meta, file_key, file_name, mime, size, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(id, kind, title, metaStr, fileKey, fileName, mime, len, Date.now()).run();

  return json({ ok: true, id, fileUrl: fileKey ? `${url.origin}/api/file/${fileKey}` : null }, 201);
}

// ---------- отдача файла ----------

async function getFile(request, path, env) {
  const key = decodeURIComponent(path.slice("/api/file/".length));
  const obj = await env.BUCKET.get(key, { range: request.headers });
  if (!obj) return json({ error: "file not found" }, 404);

  const headers = new Headers(corsHeaders());
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Accept-Ranges", "bytes");

  const ct = (headers.get("Content-Type") || "").toLowerCase();
  const inline = INLINE_TYPES.includes(ct);
  const row = await env.DB.prepare("SELECT file_name FROM items WHERE file_key = ?").bind(key).first();
  const name = (row && row.file_name) || "file";
  headers.set(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`
  );

  let status = 200;
  if (obj.range && request.headers.get("range")) {
    const off = obj.range.offset ?? 0;
    const len = obj.range.length ?? obj.size - off;
    headers.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set("Content-Length", String(len));
    status = 206;
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}

// ---------- удаление (только админ) ----------

async function deleteItem(request, path, env) {
  if ((await getRole(request, env)) !== "admin") return json({ error: "admin password required" }, 401);
  const id = path.slice("/api/items/".length);
  const row = await env.DB.prepare("SELECT file_key FROM items WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  if (row.file_key) await env.BUCKET.delete(row.file_key);
  await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- общие данные сайта (списки, новости, настройки) ----------

const STATE_KEY = /^snk_[a-z_]{1,60}$/;

async function getState(path, env) {
  const key = path.slice("/api/state/".length);
  if (!STATE_KEY.test(key)) return json({ error: "bad key" }, 400);
  const obj = await env.BUCKET.get("state/" + key);
  if (!obj) return json({ error: "no data" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() },
  });
}

async function putState(request, path, env) {
  if ((await getRole(request, env)) !== "admin") return json({ error: "admin password required" }, 401);
  const key = path.slice("/api/state/".length);
  if (!STATE_KEY.test(key)) return json({ error: "bad key" }, 400);
  const text = await request.text();
  if (text.length > 4 * 1024 * 1024) return json({ error: "too large" }, 413);
  await env.BUCKET.put("state/" + key, text, { httpMetadata: { contentType: "text/plain" } });
  return json({ ok: true });
}

// ---------- аккаунты участников и их работы ----------

const PBKDF2_ITER = 20000; // для бесплатного плана Workers; при ошибке "CPU limit" уменьшите
const WORK_TYPES = ["article", "thesis", "conference", "achievement", "methodical", "other"];
const enc = new TextEncoder();

function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function sha256(s) { return b64(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hashPw(pw, saltB64) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: PBKDF2_ITER }, key, 256);
  return b64(bits);
}
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

function workFields(b, origin) {
  const type = WORK_TYPES.includes(b.type) ? b.type : "other";
  const title = clean(b.title, 300);
  const link = clean(b.link, 500);
  const fileUrl = clean(b.file_url, 500);
  const workDate = clean(b.work_date, 7);
  if (!title) return { error: "Укажите название" };
  if (link && !/^https?:\/\//i.test(link)) return { error: "Ссылка должна начинаться с http:// или https://" };
  if (fileUrl && !fileUrl.startsWith(origin + "/api/file/")) return { error: "Недопустимая ссылка на файл" };
  if (workDate && !/^\d{4}-(0[1-9]|1[0-2])$/.test(workDate)) return { error: "Дата должна быть в формате ГГГГ-ММ" };
  return {
    type, title, venue: clean(b.venue, 300), link, fileUrl, fileName: clean(b.file_name, 200),
    authors: clean(b.authors, 300), pubCharacter: clean(b.pub_character, 60),
    pubStatus: ["опубликовано", "в печати"].includes(b.pub_status) ? b.pub_status : "",
    chars: parseInt(b.chars, 10) || null, workDate, description: clean(b.description, 600),
    year: workDate ? parseInt(workDate.slice(0, 4), 10) : (parseInt(b.year, 10) || null),
  };
}

// Роли руководства назначает только админ
const LEAD_RE = /руководител|заместител|председател/i;
function cleanProfile(p, prev, isAdmin) {
  p = p && typeof p === "object" ? p : {};
  prev = prev || {};
  const pick = (k, max) => (p[k] === undefined ? (prev[k] || "") : clean(p[k], max));
  let status = pick("status", 60) || "Участник";
  if (!isAdmin && LEAD_RE.test(status) && status !== prev.status) status = prev.status || "Участник";
  let avatar = typeof p.avatar === "string" && p.avatar ? p.avatar : (prev.avatar || "");
  if (!/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(avatar) || avatar.length > 80000) avatar = prev.avatar || "";
  return {
    status, alias: pick("alias", 40), work: pick("work", 150), spin: pick("spin", 30), elibrary: pick("elibrary", 30),
    orcid: pick("orcid", 30), pubs: pick("pubs", 100), activity: pick("activity", 120), bio: pick("bio", 600), avatar,
  };
}

async function accountRoutes(request, url, env) {
  const m = request.method, path = url.pathname;
  const role = await getRole(request, env);
  const admin = role === "admin";
  const user = role === "user" ? await getUser(request, env) : null;
  const parts = path.split("/"); // ["", "api", "works", "<id>", "<action>"]

  if (m === "POST" && path === "/api/register") {
    const b = await readJson(request);
    const login = clean(b.login, 30).toLowerCase(), name = clean(b.name, 100), course = clean(b.course, 40);
    const pw = (b.password || "").toString();
    if (!/^[a-z0-9_.-]{3,30}$/.test(login) || name.length < 3 || pw.length < 8 || pw.length > 100) {
      return json({ error: "Проверьте поля: логин (латиница/цифры, от 3 знаков), ФИО, пароль от 8 знаков" }, 400);
    }
    if (await env.DB.prepare("SELECT id FROM users WHERE login = ?").bind(login).first()) return json({ error: "Такой логин уже занят" }, 409);
    const profile = JSON.stringify(cleanProfile(b.profile, {}, false));
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    await env.DB.prepare("INSERT INTO users (id, login, name, course, salt, pass_hash, status, created_at, profile) VALUES (?,?,?,?,?,?,'pending',?,?)")
      .bind(crypto.randomUUID(), login, name, course, salt, await hashPw(pw, salt), Date.now(), profile).run();
    return json({ ok: true }, 201);
  }

  if (m === "POST" && path === "/api/login") {
    const b = await readJson(request);
    const row = await env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(clean(b.login, 30).toLowerCase()).first();
    const pw = (b.password || "").toString().slice(0, 100);
    if (!row || !safeEqual(await hashPw(pw, row.salt), row.pass_hash)) return json({ error: "Неверный логин или пароль" }, 401);
    if (row.status === "pending") return json({ error: "Аккаунт ждёт подтверждения администратором" }, 403);
    if (row.status !== "active") return json({ error: "Аккаунт заблокирован" }, 403);
    const token = hex(32);
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)")
      .bind(await sha256(token), row.id, Date.now() + 30 * 864e5).run();
    return json({ token, user: { id: row.id, login: row.login, name: row.name, course: row.course } });
  }

  if (m === "GET" && path === "/api/members") { // публично: только подтверждённые, без логинов
    const { results } = await env.DB.prepare("SELECT id, name, course, profile FROM users WHERE status = 'active' ORDER BY created_at").all();
    return json({ members: results.map((r) => ({ id: r.id, name: r.name, course: r.course, profile: safeParse(r.profile) })) });
  }

  if (m === "GET" && path === "/api/me") {
    if (!user) return json({ error: "Войдите в аккаунт" }, 401);
    return json({ user: { id: user.id, login: user.login, name: user.name, course: user.course, profile: safeParse(user.profile) } });
  }

  if (m === "PUT" && path === "/api/me/profile") { // участник правит себя сам, без подтверждения (кроме ФИО и ролей руководства)
    if (!user) return json({ error: "Войдите в аккаунт" }, 401);
    const b = await readJson(request);
    const prof = cleanProfile(b.profile, safeParse(user.profile), false);
    const course = b.course === undefined ? user.course : clean(b.course, 40);
    await env.DB.prepare("UPDATE users SET profile = ?, course = ? WHERE id = ?").bind(JSON.stringify(prof), course, user.id).run();
    return json({ ok: true, profile: prof });
  }

  // ----- работы -----
  if (path === "/api/works" && m === "GET") {
    let where = "w.status = 'approved'", args = [];
    if (url.searchParams.get("mine") === "1") {
      if (!user) return json({ error: "Войдите в аккаунт" }, 401);
      where = "w.user_id = ?"; args = [user.id];
    } else if (url.searchParams.get("all") === "1") {
      if (!admin) return json({ error: "Нужен пароль админа" }, 401);
      where = "1 = 1";
    }
    const { results } = await env.DB.prepare(
      "SELECT w.*, u.name AS author, u.course AS course FROM works w JOIN users u ON u.id = w.user_id WHERE " + where + " ORDER BY w.created_at DESC LIMIT 1000"
    ).bind(...args).all();
    return json({ works: results });
  }

  if (path === "/api/works" && m === "POST") {
    if (!user) return json({ error: "Войдите в аккаунт" }, 401);
    const f = workFields(await readJson(request), url.origin);
    if (f.error) return json({ error: f.error }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO works (id, user_id, type, title, venue, year, link, file_url, file_name, authors, pub_character, pub_status, chars, work_date, description, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)")
      .bind(id, user.id, f.type, f.title, f.venue, f.year, f.link, f.fileUrl, f.fileName, f.authors, f.pubCharacter, f.pubStatus, f.chars, f.workDate, f.description, Date.now()).run();
    return json({ ok: true, id }, 201);
  }

  if (parts[2] === "works" && parts[3]) {
    const id = parts[3];
    const work = await env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(id).first();
    if (!work) return json({ error: "not found" }, 404);

    if (m === "PUT") { // правка: хозяин, пока не подтверждено, или админ
      if (!admin && !(user && user.id === work.user_id && work.status === "pending")) return json({ error: "Нет прав на правку" }, 403);
      const f = workFields(await readJson(request), url.origin);
      if (f.error) return json({ error: f.error }, 400);
      await env.DB.prepare("UPDATE works SET type=?, title=?, venue=?, year=?, link=?, file_url=?, file_name=?, authors=?, pub_character=?, pub_status=?, chars=?, work_date=?, description=? WHERE id=?")
        .bind(f.type, f.title, f.venue, f.year, f.link, f.fileUrl, f.fileName, f.authors, f.pubCharacter, f.pubStatus, f.chars, f.workDate, f.description, id).run();
      return json({ ok: true });
    }
    if (!admin) return json({ error: "Нужен пароль админа" }, 401);
    if (m === "POST" && parts[4] === "status") {
      const st = (await readJson(request)).status === "approved" ? "approved" : "pending";
      await env.DB.prepare("UPDATE works SET status = ?, approved_at = ? WHERE id = ?").bind(st, st === "approved" ? Date.now() : null, id).run();
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM works WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
  }

  // ----- участники (только админ) -----
  if (parts[2] === "users") {
    if (!admin) return json({ error: "Нужен пароль админа" }, 401);
    if (m === "GET" && !parts[3]) {
      const { results } = await env.DB.prepare("SELECT id, login, name, course, status, created_at, profile FROM users ORDER BY created_at DESC LIMIT 1000").all();
      return json({ users: results.map((r) => ({ ...r, profile: safeParse(r.profile) })) });
    }
    const id = parts[3];
    if (m === "PUT" && id) { // админ правит ФИО, курс, роль и всю анкету
      const b = await readJson(request);
      const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "not found" }, 404);
      const name = b.name === undefined ? row.name : clean(b.name, 100);
      if (name.length < 3) return json({ error: "ФИО слишком короткое" }, 400);
      const course = b.course === undefined ? row.course : clean(b.course, 40);
      const prof = cleanProfile(b.profile, safeParse(row.profile), true);
      await env.DB.prepare("UPDATE users SET name = ?, course = ?, profile = ? WHERE id = ?").bind(name, course, JSON.stringify(prof), id).run();
      return json({ ok: true });
    }
    if (m === "POST" && id && parts[4] === "status") {
      const st = (await readJson(request)).status;
      if (!["active", "blocked", "pending"].includes(st)) return json({ error: "bad status" }, 400);
      await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(st, id).run();
      if (st !== "active") await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (m === "POST" && id && parts[4] === "password") {
      const pw = ((await readJson(request)).password || "").toString();
      if (pw.length < 8 || pw.length > 100) return json({ error: "Пароль от 8 знаков" }, 400);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare("UPDATE users SET salt = ?, pass_hash = ? WHERE id = ?").bind(salt, await hashPw(pw, salt), id).run();
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

// ---------- интервью (читают все, пишет только админ) ----------

const INTERVIEW_CATS = ["department_head", "teacher", "practitioner", "alumnus", "other"];

function interviewFields(b, origin) {
  const title = clean(b.title, 200);
  if (!title) return { error: "Укажите заголовок" };
  const cover = clean(b.cover_url, 500), photo = clean(b.photo_url, 500);
  const urlOk = (u) => !u || u.startsWith(origin + "/api/file/");
  if (!urlOk(cover) || !urlOk(photo)) return { error: "Недопустимая ссылка на фото" };
  const date = clean(b.interview_date, 7);
  if (date && !/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) return { error: "Дата должна быть в формате ГГГГ-ММ" };
  const body = (b.body || "").toString();
  if (body.length > 60000) return { error: "Текст слишком длинный (максимум 60 000 знаков)" };
  return {
    title, subtitle: clean(b.subtitle, 300), person: clean(b.person, 150), position: clean(b.position, 200),
    category: INTERVIEW_CATS.includes(b.category) ? b.category : "other",
    lead: clean(b.lead, 1500), body, cover, photo, date,
    published: b.published === false || b.published === 0 ? 0 : 1,
  };
}

async function interviewRoutes(request, url, env) {
  const m = request.method, id = url.pathname.split("/")[3];
  const admin = (await getRole(request, env)) === "admin";

  if (m === "GET" && !id) {
    const where = admin && url.searchParams.get("all") === "1" ? "1 = 1" : "published = 1";
    const { results } = await env.DB.prepare(
      "SELECT id, title, subtitle, person, position, category, substr(lead, 1, 300) AS lead, cover_url, interview_date, published, created_at FROM interviews WHERE " + where + " ORDER BY created_at DESC LIMIT 500"
    ).all();
    return json({ interviews: results });
  }
  if (m === "GET" && id) {
    const row = await env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(id).first();
    if (!row || (!row.published && !admin)) return json({ error: "not found" }, 404);
    return json({ interview: row });
  }

  if (!admin) return json({ error: "Нужен пароль админа" }, 401);

  if (m === "POST" && !id) {
    const f = interviewFields(await readJson(request), url.origin);
    if (f.error) return json({ error: f.error }, 400);
    const newId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO interviews (id, title, subtitle, person, position, category, lead, body, cover_url, photo_url, interview_date, published, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(newId, f.title, f.subtitle, f.person, f.position, f.category, f.lead, f.body, f.cover, f.photo, f.date, f.published, Date.now()).run();
    return json({ ok: true, id: newId }, 201);
  }
  if (m === "PUT" && id) {
    if (!(await env.DB.prepare("SELECT id FROM interviews WHERE id = ?").bind(id).first())) return json({ error: "not found" }, 404);
    const f = interviewFields(await readJson(request), url.origin);
    if (f.error) return json({ error: f.error }, 400);
    await env.DB.prepare("UPDATE interviews SET title=?, subtitle=?, person=?, position=?, category=?, lead=?, body=?, cover_url=?, photo_url=?, interview_date=?, published=? WHERE id=?")
      .bind(f.title, f.subtitle, f.person, f.position, f.category, f.lead, f.body, f.cover, f.photo, f.date, f.published, id).run();
    return json({ ok: true });
  }
  if (m === "DELETE" && id) {
    await env.DB.prepare("DELETE FROM interviews WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
