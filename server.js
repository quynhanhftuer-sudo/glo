'use strict';
/* Glow Base backend — Node >= 22.13, không cần gói ngoài, không gửi email. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { promisify } = require('node:util'), { DatabaseSync } = require('node:sqlite');
const scrypt = promisify(crypto.scrypt);

// ---- cấu hình (.env hoặc biến môi trường) ----
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2'); } } catch {}
const E = process.env, PORT = +E.PORT || 3000, PROD = E.NODE_ENV === 'production';
const ADMIN = (E.ADMIN_EMAIL || '').trim().toLowerCase();
const DATA = E.DATA_DIR || path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads'), PUB = path.join(__dirname, 'public');
fs.mkdirSync(UP, { recursive: true });
const SECRET = E.APP_SECRET || crypto.randomBytes(32).toString('hex');
const IDLE = Math.max(1, +E.SESSION_IDLE_SEC || 900) * 1000; // 15 phút không thao tác → phải đăng nhập lại (chỉnh bằng SESSION_IDLE_SEC)
const SESSION_MAX = 30 * 864e5;                              // trần tuyệt đối của một phiên: 30 ngày
const SEED_MAX = 999999;                                      // concept có sẵn trong giao diện: id 1…999999; concept do MUA đăng: id ≥ 1000001 (do server cấp)
if (PROD && !E.DATA_DIR) console.warn('[CẢNH BÁO] Chưa đặt DATA_DIR → database (tài khoản, phiên đăng nhập, đánh giá…) nằm trong thư mục app và sẽ MẤT khi hosting khởi động lại / deploy lại. Hãy gắn ổ đĩa bền vững và đặt DATA_DIR.');

// ---- database ----
const db = new DatabaseSync(path.join(DATA, 'glowbase.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY, name TEXT NOT NULL, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', avatar TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(tok TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS subs(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(email), status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', submitted_at INTEGER NOT NULL, reviewed_at INTEGER, data TEXT NOT NULL, mid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mua_ids(id INTEGER PRIMARY KEY AUTOINCREMENT);
INSERT OR IGNORE INTO mua_ids(id) VALUES(1000000);
CREATE TABLE IF NOT EXISTS favs(email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, mid INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(email, mid));
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, owner TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE, rating INTEGER NOT NULL, comment TEXT NOT NULL, photos TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_mid ON reviews(mid);
CREATE TABLE IF NOT EXISTS removed(mid INTEGER PRIMARY KEY, at INTEGER NOT NULL);`);
try { db.exec('ALTER TABLE sessions ADD COLUMN max_exp INTEGER'); } catch {} // DB cũ chưa có cột trần 30 ngày
// Khoá "một email = một tài khoản": Gmail không phân biệt dấu chấm và đuôi +abc (a.b+x@gmail.com = ab@gmail.com), nên chuẩn hoá trước khi so sánh.
const ekey = e => { e = String(e).trim().toLowerCase(); const m = e.match(/^([^@]+)@(gmail|googlemail)\.com$/); return m ? m[1].split('+')[0].replace(/\./g, '') + '@gmail.com' : e; };
try { db.exec('ALTER TABLE users ADD COLUMN ekey TEXT'); } catch {} // DB cũ chưa có cột ekey
for (const r of db.prepare('SELECT email FROM users WHERE ekey IS NULL').all()) db.prepare('UPDATE users SET ekey=? WHERE email=?').run(ekey(r.email), r.email);
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_ekey ON users(ekey)'); }
catch { console.warn('[CẢNH BÁO] Trong DB đã có 2 tài khoản trùng một Gmail (khác nhau chỗ dấu chấm hoặc đuôi +). Server vẫn chặn đăng ký trùng mới, nhưng hãy xử lý tài khoản cũ.'); }
if (ADMIN) db.prepare("UPDATE users SET role='admin' WHERE email=?").run(ADMIN);
const q = s => db.prepare(s);

// ---- tiện ích ----
const now = () => Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hashPw = async p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + (await scrypt(p, s, 64)).toString('hex'); };
const checkPw = async (p, st) => { const [s, h] = st.split(':'); return same((await scrypt(p, Buffer.from(s, 'hex'), 64)).toString('hex'), h); };
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const bad = (m, s = 400) => new HttpErr(s, m);
const hits = new Map();
const over = (k, max, win) => (hits.get(k) || []).filter(x => now() - x < win).length >= max;
const hit = k => { const a = (hits.get(k) || []).filter(x => now() - x < 3600e3); a.push(now()); hits.set(k, a); };
setInterval(() => { const t = now(); for (const [k, a] of hits) if (!a.some(x => t - x < 3600e3)) hits.delete(k); q('DELETE FROM sessions WHERE exp<? OR (max_exp IS NOT NULL AND max_exp<?)').run(t, t); }, 600e3).unref();

// ---- làm sạch dữ liệu (chống XSS: giao diện render HTML thô nên server phải escape) ----
const unesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const txt = (s, min, max, label) => { const raw = unesc(typeof s === 'string' ? s : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(); if (raw.length < min || raw.length > max) throw bad(`${label} cần từ ${min} đến ${max} ký tự.`); return esc(raw); };
const pick = (v, list, label) => { if (!list.includes(v)) throw bad(`${label} không hợp lệ.`); return v; };
const num = x => { const n = Math.floor(Number(x) || 0); if (n < 0 || n > 1e9) throw bad('Giá không hợp lệ.'); return n; };
const GMAIL = /^[a-z0-9][a-z0-9.]{4,28}[a-z0-9]@gmail\.com$/i;
const HREF = /^(https?:\/\/[^\s"'<>]+|tel:\+?\d{8,15}|mailto:[^\s"'<>@]+@[^\s"'<>@]+)$/i;
const CONCEPTS = ['Cô dâu', 'Đi tiệc', 'Kỉ yếu', 'Cosplay'], CTYPES = ['phone', 'facebook', 'instagram', 'tiktok', 'email', 'website'];
const MAGIC = { jpg: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF, png: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])), webp: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
function saveImg(s) {
  if (typeof s !== 'string') throw bad('Ảnh không hợp lệ.');
  if (/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(s)) { if (!fs.existsSync(path.join(UP, path.basename(s)))) throw bad('Ảnh không tồn tại.'); return s; }
  const m = s.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/); if (!m) throw bad('Ảnh phải là JPG, PNG hoặc WebP.');
  const b = Buffer.from(m[2], 'base64'), ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  if (b.length > 1.5e6) throw bad('Mỗi ảnh tối đa 1,5MB.'); if (!MAGIC[ext](b)) throw bad('Nội dung ảnh không hợp lệ.');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext; fs.writeFileSync(path.join(UP, name), b); return '/uploads/' + name;
}
const fmt = x => x.toLocaleString('vi-VN');
function cleanSub(d, prev) {
  if (!d || typeof d !== 'object') throw bad('Thiếu dữ liệu hồ sơ.');
  const out = { name: txt(d.name, 2, 80, 'Tên / nghệ danh'), bio: txt(d.bio || '', 0, 1000, 'Giới thiệu'), type: pick(d.type, ['Studio', 'Tại gia'], 'Loại hình'),
    province: txt(d.province, 2, 40, 'Tỉnh / thành'), address: txt(d.address, 6, 200, 'Địa chỉ') };
  if (d.svc) { out.svc = pick(d.svc, ['home', 'studio', 'both'], 'Dịch vụ'); out.mobile = out.svc !== 'studio'; } else out.mobile = !!d.mobile;
  if (!Array.isArray(d.contacts) || d.contacts.length < 1 || d.contacts.length > 8) throw bad('Cần 1–8 kênh liên hệ.');
  out.contacts = d.contacts.map(c => { c = c || {}; if (typeof c.href !== 'string' || !HREF.test(c.href)) throw bad('Liên kết liên hệ không hợp lệ.'); return { type: pick(c.type, CTYPES, 'Kênh liên hệ'), label: txt(c.label, 1, 100, 'Thông tin liên hệ'), href: c.href }; });
  if (!Array.isArray(d.concepts) || d.concepts.length < 1 || d.concepts.length > CONCEPTS.length) throw bad('Cần chọn ít nhất 1 concept.');
  const seen = new Set();
  out.concepts = d.concepts.map(c => { c = c || {}; const concept = pick(c.concept, CONCEPTS, 'Concept'); if (seen.has(concept)) throw bad('Concept bị trùng.'); seen.add(concept);
    const lo = num(c.lo), hi = num(c.hi); if (hi && hi < lo) throw bad('Giá “đến” phải ≥ giá “từ”.');
    if (!Array.isArray(c.photos) || c.photos.length < 1 || c.photos.length > 8) throw bad(`Concept “${concept}” cần 1–8 ảnh.`);
    return { concept, lo, hi, price: lo && hi ? `${fmt(lo)} - ${fmt(hi)}đ` : lo ? `Từ ${fmt(lo)}đ` : 'Contact', photos: c.photos }; });
  // mọi kiểm tra chữ đã qua → mới ghi ảnh ra đĩa
  out.avatar = d.avatar ? saveImg(d.avatar) : '';
  out.concepts.forEach(c => { c.photos = c.photos.map(saveImg); });
  const old = {}; if (prev) prev.data.concepts.forEach((c, k) => { old[c.concept] = prev.mid[k]; });
  const mid = out.concepts.map(c => old[c.concept] || Number(q('INSERT INTO mua_ids DEFAULT VALUES').run().lastInsertRowid));
  return { data: out, mid };
}

// ---- ảnh: dọn file không còn ai dùng ----
const IMGP = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/;
const unlinkUp = p => fs.rm(path.join(UP, path.basename(p)), { force: true }, () => {});
const imgInUse = p => q('SELECT 1 FROM subs WHERE data LIKE ? LIMIT 1').get('%' + p + '%') || q('SELECT 1 FROM reviews WHERE photos LIKE ? LIMIT 1').get('%' + p + '%') || q('SELECT 1 FROM users WHERE avatar=? LIMIT 1').get(p);
const dropImgs = list => { for (const p of new Set(list)) if (typeof p === 'string' && IMGP.test(p) && !imgInUse(p)) unlinkUp(p); };
function savePhotos(list) { // lưu từng ảnh; nếu một ảnh lỗi thì xoá các ảnh mới đã ghi trước đó
  const out = [], fresh = [];
  try { for (const p of list) { const s = saveImg(p); if (!IMGP.test(String(p))) fresh.push(s); out.push(s); } } catch (e) { fresh.forEach(unlinkUp); throw e; }
  return out;
}
const toInt = (x, label = 'Mã') => { const n = Number(x); if (!Number.isInteger(n) || n < 1) throw bad(`${label} không hợp lệ.`); return n; };

// ---- concept còn hiển thị: concept có sẵn chưa bị admin xoá, hoặc concept của hồ sơ MUA đang ở trạng thái "đã duyệt" ----
const removedSet = () => new Set(q('SELECT mid FROM removed').all().map(r => r.mid));
const approvedMids = () => { const s = new Set(); for (const r of q("SELECT mid FROM subs WHERE status='approved'").all()) for (const m of JSON.parse(r.mid)) s.add(m); return s; };
const liveCheck = () => { const rm = removedSet(), ap = approvedMids(); return m => m >= 1 && !rm.has(m) && (m <= SEED_MAX || ap.has(m)); };

// ---- yêu thích & đánh giá ----
const favsOf = email => q('SELECT mid FROM favs WHERE email=? ORDER BY at').all(email).map(r => r.mid);
const getRev = id => q('SELECT r.*, u.name AS owner_name FROM reviews r JOIN users u ON u.email=r.owner WHERE r.id=?').get(id);
const revOut = (r, v) => ({ id: r.id, muaId: r.mid, userId: v && v.email === r.owner ? r.owner : 'u_' + sha(r.owner).slice(0, 8), userName: r.owner_name, rating: r.rating, comment: r.comment,
  photos: JSON.parse(r.photos), date: new Date(r.updated_at + 7 * 3600e3).toISOString().slice(0, 10) });
function cleanReview(b) { // kiểm tra chữ trước, ghi ảnh sau
  const rating = Number(b.rating); if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Vui lòng chọn từ 1 đến 5 sao.');
  const comment = txt(b.comment, 1, 2000, 'Nhận xét'), photos = b.photos === undefined ? [] : b.photos;
  if (!Array.isArray(photos) || photos.length > 6) throw bad('Mỗi đánh giá tối đa 6 ảnh.');
  return { rating, comment, photos };
}

// ---- mô hình trả về ----
const pubUser = u => ({ email: u.email, name: u.name, role: u.role, avatar: u.avatar || '' });
const getSub = id => q('SELECT s.*, u.name AS owner_name FROM subs s JOIN users u ON u.email=s.owner WHERE s.id=?').get(id);
const subOut = (r, v) => { const own = v && (v.role === 'admin' || v.email === r.owner);
  return { id: r.id, owner: own ? r.owner : 'u_' + sha(r.owner).slice(0, 8), ownerName: own ? r.owner_name : '', status: r.status, reason: r.reason, submittedAt: r.submitted_at, reviewedAt: r.reviewed_at || undefined, mid: JSON.parse(r.mid), data: JSON.parse(r.data) }; };

// ---- session ----
const cookie = (req, n) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + n + '=([0-9a-f]+)')); return m ? m[1] : null; };
const setCookie = (res, v, age) => res.setHeader('Set-Cookie', `gb_sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${PROD ? '; Secure' : ''}`);
// phiên trượt: mỗi request hợp lệ kéo hạn thêm IDLE; quá IDLE không có request nào (client tự gửi "ping" khi người dùng còn thao tác) thì hết phiên
const userOf = req => {
  const t = cookie(req, 'gb_sid'); if (!t) return null;
  const k = sha(t), t0 = now();
  const r = q('SELECT u.*, s.exp AS s_exp FROM sessions s JOIN users u ON u.email=s.email WHERE s.tok=? AND s.exp>? AND (s.max_exp IS NULL OR s.max_exp>?)').get(k, t0, t0);
  if (!r) return null;
  if (Math.abs(r.s_exp - (t0 + IDLE)) > Math.min(10e3, IDLE / 4)) q('UPDATE sessions SET exp=? WHERE tok=?').run(t0 + IDLE, k); // cũng thu gọn các phiên cũ (30 ngày) về đúng IDLE
  return r;
};
// cookie sống 30 ngày để tải lại trang / đóng mở trình duyệt vẫn còn đăng nhập; việc hết phiên do không thao tác do server quyết định
const startSession = (res, email) => { const t = crypto.randomBytes(32).toString('hex'), t0 = now(); q('INSERT INTO sessions(tok,email,exp,max_exp) VALUES(?,?,?,?)').run(sha(t), email, t0 + IDLE, t0 + SESSION_MAX); setCookie(res, t, SESSION_MAX / 1000); };

// ---- API ----
const R = [];
const route = (m, p, fn, o = {}) => R.push({ m, o, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

route('GET', '/api/health', () => ({ ok: true }));
route('GET', '/api/boot', ({ u }) => { // người dùng hiện tại + hồ sơ MUA được phép thấy + đánh giá + yêu thích + concept đã bị xoá
  const rows = u && u.role === 'admin' ? q('SELECT s.*, x.name AS owner_name FROM subs s JOIN users x ON x.email=s.owner ORDER BY submitted_at DESC').all()
    : q("SELECT s.*, x.name AS owner_name FROM subs s JOIN users x ON x.email=s.owner WHERE s.status='approved' OR s.owner=? ORDER BY submitted_at DESC").all(u ? u.email : '');
  const live = liveCheck(), reviews = q('SELECT r.*, x.name AS owner_name FROM reviews r JOIN users x ON x.email=r.owner ORDER BY r.id').all().filter(r => live(r.mid)).map(r => revOut(r, u));
  return { user: u ? pubUser(u) : null, subs: rows.map(r => subOut(r, u)), idleMs: IDLE, favs: u ? favsOf(u.email) : [], reviews, removed: [...removedSet()] }; });

route('POST', '/api/auth/register', async ({ res, body, ip }) => {
  const name = txt(body.name, 2, 60, 'Tên hiển thị'), email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
  if (!GMAIL.test(email) || email.includes('..')) throw bad('Vui lòng nhập địa chỉ Gmail hợp lệ (dạng tenban@gmail.com).');
  if (pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.');
  if (over('reg:' + ip, 10, 3600e3) || over('regm:' + email, 5, 3600e3)) throw bad('Bạn thao tác quá nhiều lần, hãy thử lại sau.', 429);
  hit('reg:' + ip); hit('regm:' + email);
  const k = ekey(email), taken = () => bad('Gmail này đã được đăng ký.', 409);
  // Không còn xác minh email nên KHÔNG cho đăng ký bằng ADMIN_EMAIL (tránh bị chiếm quyền admin); tài khoản admin tạo từ ADMIN_PASSWORD lúc khởi động.
  if (ADMIN && k === ekey(ADMIN)) throw taken();
  if (q('SELECT 1 FROM users WHERE ekey=? OR email=?').get(k, email)) throw taken();
  try { q('INSERT INTO users(email,name,pass,role,avatar,created_at,ekey) VALUES(?,?,?,?,NULL,?,?)').run(email, name, await hashPw(pw), 'user', now(), k); } catch { throw taken(); }
  startSession(res, email);
  return { user: pubUser(q('SELECT * FROM users WHERE email=?').get(email)) }; });

route('POST', '/api/auth/login', async ({ res, body, ip }) => {
  const id = String(body.identifier || '').trim().toLowerCase(), pw = String(body.password || '');
  if (over('log:' + ip, 20, 900e3) || over('logid:' + id, 8, 900e3)) throw bad('Bạn đăng nhập sai quá nhiều lần. Hãy đợi 15 phút.', 429);
  const u = q('SELECT * FROM users WHERE email=?').get(id), ok = u ? await checkPw(pw, u.pass) : (await hashPw(pw), false);
  if (!ok) { hit('log:' + ip); hit('logid:' + id); throw bad('Sai tài khoản hoặc mật khẩu.', 401); }
  startSession(res, u.email); return { user: pubUser(u) }; });

route('POST', '/api/auth/logout', ({ req, res }) => { const t = cookie(req, 'gb_sid'); if (t) q('DELETE FROM sessions WHERE tok=?').run(sha(t)); setCookie(res, '', 0); return { ok: true }; });

route('PUT', '/api/me', ({ u, body }) => {
  for (const k of ['email', 'username', 'id']) if (body[k] !== undefined && String(body[k]).trim().toLowerCase() !== u.email) throw bad('Tên đăng nhập chính là Gmail bạn đã đăng ký nên không thể thay đổi.');
  const name = body.name !== undefined ? txt(body.name, 2, 60, 'Tên hiển thị') : u.name;
  const avatar = body.avatar === undefined ? u.avatar : body.avatar ? saveImg(body.avatar) : null;
  q('UPDATE users SET name=?, avatar=? WHERE email=?').run(name, avatar, u.email); return { user: pubUser(q('SELECT * FROM users WHERE email=?').get(u.email)) }; }, { auth: 1 });

route('POST', '/api/me/password', async ({ req, u, body, ip }) => {
  if (over('pw:' + u.email, 5, 900e3)) throw bad('Bạn thử quá nhiều lần, hãy đợi 15 phút.', 429);
  const o = String(body.old || ''), n = String(body.new || '');
  if (!(await checkPw(o, u.pass))) { hit('pw:' + u.email); throw bad('Mật khẩu hiện tại chưa đúng.', 403); }
  if (n.length < 6 || n.length > 128) throw bad('Mật khẩu mới cần từ 6 đến 128 ký tự.'); if (n === o) throw bad('Mật khẩu mới phải khác mật khẩu hiện tại.');
  q('UPDATE users SET pass=? WHERE email=?').run(await hashPw(n), u.email);
  q('DELETE FROM sessions WHERE email=? AND tok<>?').run(u.email, sha(cookie(req, 'gb_sid'))); return { ok: true }; }, { auth: 1 });

route('POST', '/api/submissions', ({ u, body }) => {
  if (over('sub:' + u.email, 10, 3600e3)) throw bad('Bạn gửi hồ sơ quá nhiều lần, hãy thử lại sau.', 429);
  if (q('SELECT COUNT(*) AS n FROM subs WHERE owner=?').get(u.email).n >= 10) throw bad('Mỗi tài khoản tối đa 10 hồ sơ.', 403);
  hit('sub:' + u.email); const { data, mid } = cleanSub(body.data, null), id = 'S' + crypto.randomBytes(6).toString('hex');
  q("INSERT INTO subs(id,owner,status,submitted_at,data,mid) VALUES(?,?, 'pending', ?,?,?)").run(id, u.email, now(), JSON.stringify(data), JSON.stringify(mid));
  return { sub: subOut(getSub(id), u) }; }, { auth: 1 });

route('PUT', '/api/submissions/:id', ({ u, params, body }) => {
  const r = getSub(params.id); if (!r || r.owner !== u.email) throw bad('Không tìm thấy hồ sơ.', 404);
  if (over('sub:' + u.email, 10, 3600e3)) throw bad('Bạn gửi hồ sơ quá nhiều lần, hãy thử lại sau.', 429); hit('sub:' + u.email);
  const { data, mid } = cleanSub(body.data, { data: JSON.parse(r.data), mid: JSON.parse(r.mid) });
  q("UPDATE subs SET data=?, mid=?, status='pending', reason='', submitted_at=?, reviewed_at=NULL WHERE id=?").run(JSON.stringify(data), JSON.stringify(mid), now(), r.id);
  return { sub: subOut(getSub(r.id), u) }; }, { auth: 1 });

const review = act => ({ u, params, body }) => {
  const r = getSub(params.id); if (!r) throw bad('Không tìm thấy hồ sơ.', 404);
  if (act === 'approve') q("UPDATE subs SET status='approved', reason='', reviewed_at=? WHERE id=?").run(now(), r.id);
  else if (act === 'reject') q("UPDATE subs SET status='rejected', reason=?, reviewed_at=? WHERE id=?").run(txt(body.reason, 5, 300, 'Lý do từ chối'), now(), r.id);
  else q("UPDATE subs SET status='rejected', reason='Hồ sơ đã được gỡ xuống bởi quản trị viên.', reviewed_at=? WHERE id=?").run(now(), r.id);
  return { sub: subOut(getSub(r.id), u) };
};
for (const a of ['approve', 'reject', 'unpublish']) route('POST', `/api/admin/submissions/:id/${a}`, review(a), { admin: 1 });

route('POST', '/api/session/ping', () => ({ ok: true, idleMs: IDLE }), { auth: 1 }); // userOf đã gia hạn phiên; client gọi khi người dùng còn thao tác

// ---- yêu thích ----
route('GET', '/api/favorites', ({ u }) => ({ favs: favsOf(u.email) }), { auth: 1 });
route('PUT', '/api/favorites/:mid', ({ u, params }) => {
  const mid = toInt(params.mid, 'Mã concept'); if (!liveCheck()(mid)) throw bad('Concept này không còn tồn tại.', 404);
  if (over('fav:' + u.email, 120, 600e3)) throw bad('Bạn thao tác quá nhanh, hãy thử lại sau ít phút.', 429); hit('fav:' + u.email);
  if (q('SELECT COUNT(*) AS n FROM favs WHERE email=?').get(u.email).n >= 500) throw bad('Danh sách yêu thích tối đa 500 concept.', 403);
  q('INSERT OR IGNORE INTO favs VALUES(?,?,?)').run(u.email, mid, now()); return { favs: favsOf(u.email) }; }, { auth: 1 });
route('DELETE', '/api/favorites/:mid', ({ u, params }) => {
  q('DELETE FROM favs WHERE email=? AND mid=?').run(u.email, toInt(params.mid, 'Mã concept')); return { favs: favsOf(u.email) }; }, { auth: 1 });

// ---- đánh giá ----
route('POST', '/api/reviews', ({ u, body }) => {
  const mid = toInt(body.mid, 'Mã concept'); if (!liveCheck()(mid)) throw bad('Concept này không còn tồn tại.', 404);
  if (over('rev:' + u.email, 20, 3600e3)) throw bad('Bạn đánh giá quá nhiều lần, hãy thử lại sau.', 429);
  const c = cleanReview(body); hit('rev:' + u.email);
  const photos = savePhotos(c.photos), id = (q('SELECT MAX(id) AS m FROM reviews').get().m || 10000) + 1, t = now();
  q('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)').run(id, mid, u.email, c.rating, c.comment, JSON.stringify(photos), t, t);
  return { review: revOut(getRev(id), u) }; }, { auth: 1 });
route('PUT', '/api/reviews/:id', ({ u, params, body }) => {
  const r = getRev(toInt(params.id, 'Mã đánh giá')); if (!r || r.owner !== u.email) throw bad('Không tìm thấy đánh giá.', 404);
  if (over('rev:' + u.email, 20, 3600e3)) throw bad('Bạn đánh giá quá nhiều lần, hãy thử lại sau.', 429);
  const c = cleanReview(body); hit('rev:' + u.email);
  const photos = savePhotos(c.photos);
  q('UPDATE reviews SET rating=?, comment=?, photos=?, updated_at=? WHERE id=?').run(c.rating, c.comment, JSON.stringify(photos), now(), r.id);
  dropImgs(JSON.parse(r.photos).filter(p => !photos.includes(p)));
  return { review: revOut(getRev(r.id), u) }; }, { auth: 1 });
route('DELETE', '/api/reviews/:id', ({ u, params }) => {
  const r = getRev(toInt(params.id, 'Mã đánh giá')); if (!r || (r.owner !== u.email && u.role !== 'admin')) throw bad('Không tìm thấy đánh giá.', 404);
  q('DELETE FROM reviews WHERE id=?').run(r.id); dropImgs(JSON.parse(r.photos)); return { ok: true }; }, { auth: 1 });

// ---- admin: xoá concept / artist (client gửi danh sách id concept; xoá artist = xoá mọi concept của artist đó) ----
route('POST', '/api/admin/concepts/delete', ({ body }) => {
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(x => toInt(x, 'Mã concept')))];
  if (!ids.length || ids.length > 200) throw bad('Danh sách concept không hợp lệ.');
  const junk = [], t = now(); db.exec('BEGIN');
  try {
    for (const id of ids) if (id <= SEED_MAX) q('INSERT OR IGNORE INTO removed VALUES(?,?)').run(id, t);
    for (const r of q('SELECT * FROM subs').all()) { // concept do MUA đăng: gỡ khỏi hồ sơ; hết concept thì hồ sơ chuyển sang "chưa được duyệt"
      const mid = JSON.parse(r.mid), data = JSON.parse(r.data); let ch = false;
      for (const id of ids) { const k = mid.indexOf(id); if (k >= 0) { junk.push(...data.concepts[k].photos); mid.splice(k, 1); data.concepts.splice(k, 1); ch = true; } }
      if (!ch) continue;
      if (mid.length) q('UPDATE subs SET data=?, mid=? WHERE id=?').run(JSON.stringify(data), JSON.stringify(mid), r.id);
      else q("UPDATE subs SET data=?, mid='[]', status='rejected', reason='Hồ sơ đã bị quản trị viên xoá.', reviewed_at=? WHERE id=?").run(JSON.stringify(data), t, r.id);
    }
    for (const id of ids) { for (const r of q('SELECT photos FROM reviews WHERE mid=?').all(id)) junk.push(...JSON.parse(r.photos)); q('DELETE FROM reviews WHERE mid=?').run(id); q('DELETE FROM favs WHERE mid=?').run(id); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  dropImgs(junk); return { removed: ids }; }, { admin: 1 });

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function sendFile(res, file, cache) {
  fs.stat(file, (e, st) => { if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache || 'no-cache' }); fs.createReadStream(file).pipe(res); });
}
async function readJson(req, max = 25e6) {
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
    if ((req.headers['content-length'] || '0') === '0' && !req.headers['transfer-encoding']) return {}; // yêu cầu không có nội dung (vd: PUT /api/favorites/7)
    throw bad('Content-Type phải là application/json.', 415);
  }
  let n = 0; const c = []; for await (const x of req) { n += x.length; if (n > max) throw bad('Dữ liệu gửi lên quá lớn.', 413); c.push(x); }
  try { const j = JSON.parse(Buffer.concat(c).toString('utf8') || '{}'); return j && typeof j === 'object' ? j : {}; } catch { throw bad('JSON không hợp lệ.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://x'), p = url.pathname, ip = (E.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  try {
    if (p.startsWith('/api/')) {
      let hit_ = null, params = {}; for (const r of R) { if (r.m !== req.method) continue; const m = p.match(r.re); if (m) { hit_ = r; params = m.groups || {}; break; } }
      if (!hit_) throw bad('Không tìm thấy.', 404);
      const u = userOf(req); if ((hit_.o.auth || hit_.o.admin) && !u) throw bad(cookie(req, 'gb_sid') ? 'Phiên đăng nhập đã hết hạn do không thao tác, vui lòng đăng nhập lại.' : 'Bạn cần đăng nhập.', 401); if (hit_.o.admin && u.role !== 'admin') throw bad('Chỉ quản trị viên mới được thực hiện.', 403);
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req), out = await hit_.fn({ req, res, u, body, params, ip });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(out));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw bad('Không hỗ trợ.', 405);
    if (p.startsWith('/uploads/')) { const n = p.slice(9); return /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(n) ? sendFile(res, path.join(UP, n), 'public, max-age=31536000, immutable') : sendFile(res, '/nonexistent'); }
    let rel; try { rel = decodeURIComponent(p); } catch { throw bad('URL không hợp lệ.'); }
    const f = path.join(PUB, path.normalize(rel === '/' ? '/index.html' : rel));
    if (!f.startsWith(PUB + path.sep) || path.basename(f).startsWith('.')) throw bad('Không tìm thấy.', 404);
    sendFile(res, f);
  } catch (e) {
    const s = e instanceof HttpErr ? e.s : 500; if (s === 500) console.error(e);
    res.writeHead(s, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: s === 500 ? 'Lỗi máy chủ.' : e.message }));
  }
});
// Tài khoản admin: tạo từ ADMIN_EMAIL + ADMIN_PASSWORD (chỉ tạo nếu chưa có; sau đó đổi mật khẩu trong giao diện thì không bị ghi đè).
(async () => {
  if (!ADMIN) return;
  if (!q('SELECT 1 FROM users WHERE email=?').get(ADMIN)) {
    const ap = E.ADMIN_PASSWORD || '';
    if (ap.length >= 8) { q('INSERT INTO users(email,name,pass,role,avatar,created_at,ekey) VALUES(?,?,?,?,NULL,?,?)').run(ADMIN, 'Admin', await hashPw(ap), 'admin', now(), ekey(ADMIN)); console.log('Đã tạo tài khoản admin:', ADMIN); }
    else console.warn('[CẢNH BÁO] Chưa có tài khoản admin. Đặt ADMIN_PASSWORD (từ 8 ký tự) trong .env/Variables rồi khởi động lại để tạo.');
  }
})().catch(e => console.error('Lỗi tạo admin:', e.message));
server.listen(PORT, () => console.log(`Glow Base chạy tại http://localhost:${PORT}  (dữ liệu: ${DATA})`));
