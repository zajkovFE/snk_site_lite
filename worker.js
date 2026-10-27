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
      if (m === "GET" && path === "/api/whoami") return json({ role: getRole(request, env) });
      if (m === "GET" && path === "/api/list") return await listItems(url, env);
      if (m === "POST" && path === "/api/items") return await createItem(request, url, env);
      if (m === "GET" && path.startsWith("/api/file/")) return await getFile(request, path, env);
      if (m === "DELETE" && path.startsWith("/api/items/")) return await deleteItem(request, path, env);

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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Password, Range",
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

// Возвращает "admin", "member" или null
function getRole(request, env) {
  const pw = request.headers.get("X-Password") || "";
  if (!pw) return null;
  if (env.ADMIN_PASSWORD && safeEqual(pw, env.ADMIN_PASSWORD)) return "admin";
  if (env.UPLOAD_PASSWORD && safeEqual(pw, env.UPLOAD_PASSWORD)) return "member";
  return null;
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
  if (!getRole(request, env)) return json({ error: "wrong password" }, 401);

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
  if (getRole(request, env) !== "admin") return json({ error: "admin password required" }, 401);
  const id = path.slice("/api/items/".length);
  const row = await env.DB.prepare("SELECT file_key FROM items WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  if (row.file_key) await env.BUCKET.delete(row.file_key);
  await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
