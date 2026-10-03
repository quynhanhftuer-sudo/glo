/* Glow Base · nối giao diện với backend thật (ghi đè các hàm cũ chạy trong trình duyệt) */
(() => {
  const SEEDFB = feedbacks.slice(); // đánh giá mẫu có sẵn trong giao diện; đánh giá thật của người dùng do server giữ
  const WAS = 'gb_was_in', LAST = 'gb_last_act'; // chỉ là cờ / mốc thời gian, KHÔNG chứa dữ liệu hay mật khẩu
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };
  let idleMs = 15 * 60e3;

  const api = async (method, url, body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) {
      const quiet = r.status === 401 && !!currentUser && !url.startsWith('/api/auth/'); // phiên đã hết hạn giữa chừng → báo bằng hộp thoại riêng
      if (quiet) sessionExpired();
      throw Object.assign(new Error(j.error || 'Không kết nối được máy chủ.'), { status: r.status, quiet });
    }
    return j;
  };
  const fail = e => { if (!e.quiet) toast(e.message || 'Có lỗi xảy ra'); };

  /* ---- phiên đăng nhập: tải lại trang vẫn còn đăng nhập; 15 phút không thao tác thì phải đăng nhập lại ---- */
  let lastAct = Date.now(), lastPing = 0, lastMark = 0, expiring = false;
  const sharedLast = () => Math.max(lastAct, +ls.get(LAST) || 0); // dùng chung giữa các tab
  const idleText = () => idleMs >= 60e3 ? Math.round(idleMs / 60e3) + ' phút' : Math.round(idleMs / 1000) + ' giây';
  function showExpired() {
    document.getElementById('modalRoot').innerHTML = `<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal confirm-box"><h2 style="font-size:20px;color:var(--text)">Phiên đăng nhập đã hết hạn</h2><div class="sub">Để bảo vệ tài khoản, bạn được đăng xuất sau ${idleText()} không thao tác. Vui lòng đăng nhập lại.</div><div class="confirm-actions"><button class="btn btn-ghost" onclick="closeModal()">Để sau</button><button class="btn btn-primary" onclick="openModal('login')">Đăng nhập</button></div></div></div>`;
  }
  async function sessionExpired() {
    if (expiring) return; expiring = true;
    try { try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} await boot(); } // boot thấy "đã từng đăng nhập mà nay không còn" → hiện hộp thoại
    finally { expiring = false; }
  }
  function markActive() { // người dùng còn thao tác → ghi mốc + báo server gia hạn phiên (tối đa mỗi 30 giây một lần)
    const t = Date.now(); if (!currentUser || t - lastMark < Math.min(5e3, idleMs / 6)) return; lastMark = t; lastAct = t; ls.set(LAST, String(t));
    if (t - lastPing >= Math.min(30e3, idleMs / 3)) { lastPing = t; api('POST', '/api/session/ping', {}).catch(() => {}); }
  }
  ['pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'mousemove'].forEach(ev => addEventListener(ev, markActive, { passive: true, capture: true }));
  const idleCheck = () => { if (currentUser && !expiring && Date.now() - sharedLast() > idleMs) sessionExpired(); };
  setInterval(idleCheck, 10e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) idleCheck(); }); // tab nền bị trình duyệt làm chậm timer → kiểm tra ngay khi quay lại

  /* ---- tải trạng thái từ server: người dùng + hồ sơ MUA ---- */
  async function boot() {
    let notice = false;
    try {
      const j = await api('GET', '/api/boot');
      idleMs = j.idleMs || idleMs;
      SUBS.forEach(s => unpublishSub(s)); SUBS.length = 0;
      j.subs.forEach(s => { s.muaIds = []; SUBS.push(s); if (s.status === 'approved') publishSub(s); });
      const gone = new Set(j.removed || []); muas = muas.filter(m => !gone.has(m.id)); // concept có sẵn mà admin đã xoá
      feedbacks = SEEDFB.filter(f => !gone.has(f.muaId)).concat(j.reviews || []);
      currentUser = j.user ? { id: j.user.email, name: j.user.name, role: j.user.role, avatar: j.user.avatar || '' } : null;
      favorites = {}; if (j.user) favorites[j.user.email] = j.favs || [];
      if (j.user) { ls.set(WAS, '1'); lastAct = Date.now(); ls.set(LAST, String(lastAct)); }
      else if (ls.get(WAS)) { ls.del(WAS); notice = true; } // trước đó đã đăng nhập mà nay server không còn phiên → hết hạn
    } catch (e) { fail(e); }
    render();
    if (notice) showExpired();
    migrateLocalDeletes();
  }
  window.gbBoot = boot;

  // hồ sơ đã duyệt dùng id concept cố định do server cấp
  const _ps = window.publishSub;
  window.publishSub = s => { _ps(s); if (s.mid && s.mid.length === s.muaIds.length) { muas.forEach(m => { const k = s.muaIds.indexOf(m.id); if (k >= 0) m.id = s.mid[k]; }); s.muaIds = [...s.mid]; } };

  /* ---- đăng nhập / đăng xuất ---- */
  window.doLogin = async () => {
    const u = document.getElementById('loginUser').value.trim(), p = document.getElementById('loginPass').value;
    if (!u || !p) return toast('Vui lòng nhập đầy đủ thông tin');
    try { await api('POST', '/api/auth/login', { identifier: u, password: p }); closeModal(); await boot(); if (!currentUser) return toast('Đã đăng nhập nhưng trình duyệt không giữ được phiên (cookie bị chặn, hoặc trang chạy qua http thay vì https).'); toast('Đăng nhập thành công ✨'); afterLogin(); } catch (e) { fail(e); }
  };
  window.logout = async () => { ls.del(WAS); try { await api('POST', '/api/auth/logout', {}); } catch {} ls.del('gb_subs_v4'); await boot(); toast('Đã đăng xuất'); go('home'); };

  /* ---- đăng ký Gmail (không cần mã xác minh; mỗi Gmail chỉ một tài khoản) ---- */
  window.regSend = async () => {
    const g = id => document.getElementById(id), v = id => g(id).value.trim(); let ok = true; const bad = (id, m) => { jerr(g(id), m); ok = false; };
    ['regName', 'regEmail', 'regPass', 'regPass2'].forEach(i => jerr(g(i), ''));
    const name = v('regName'), email = v('regEmail').toLowerCase(), pass = g('regPass').value, p2 = g('regPass2').value;
    if (name.length < 2) bad('regName', 'Vui lòng nhập tên hiển thị (ít nhất 2 ký tự).');
    if (!okGmail(email)) bad('regEmail', 'Vui lòng nhập địa chỉ Gmail hợp lệ (dạng tenban@gmail.com).');
    if (pass.length < 8 || !/[A-Za-z]/.test(pass) || !/\d/.test(pass)) bad('regPass', 'Mật khẩu cần ít nhất 8 ký tự, gồm cả chữ và số.');
    if (p2 !== pass) bad('regPass2', 'Mật khẩu xác nhận không khớp.');
    if (!ok) return;
    try { await api('POST', '/api/auth/register', { name, email, password: pass }); REG = null; closeModal(); await boot(); if (!currentUser) return toast('Tài khoản đã tạo nhưng trình duyệt không giữ được phiên (cookie bị chặn, hoặc trang chạy qua http thay vì https).'); toast('Tạo tài khoản thành công ✨'); afterLogin(); }
    catch (e) { jerr(g('regEmail'), e.message); }
  };

  /* ---- hồ sơ MUA: gửi lên server (ảnh được server lưu thành file) ---- */
  const _jf = window.jFinish; let busy = false;
  window.jFinish = async function () {
    if (busy) return; const eid = window.jEditId, t0 = Date.now(), before = new Set(SUBS.map(s => s.id)), realGo = window.go, snap = eid && subBy(eid) ? JSON.stringify(subBy(eid)) : null; let held = null;
    window.go = (p, q) => { if (p === 'joined') { held = q; return; } return realGo(p, q); };
    try { _jf.apply(this, arguments); } finally { window.go = realGo; }
    if (!held) return; // chưa qua bước kiểm tra dữ liệu
    const local = eid ? subBy(eid) : SUBS.find(s => !before.has(s.id)); if (!local || local.submittedAt < t0 - 50) return;
    busy = true; toast('Đang gửi hồ sơ…');
    try {
      const r = eid ? await api('PUT', '/api/submissions/' + eid, { data: local.data }) : await api('POST', '/api/submissions', { data: local.data });
      unpublishSub(local); const i = SUBS.indexOf(local); r.sub.muaIds = []; SUBS[i] = r.sub; go('joined', { sid: r.sub.id });
    } catch (e) {
      fail(e); if (!eid) SUBS.splice(SUBS.indexOf(local), 1); else if (snap) Object.assign(local, JSON.parse(snap)); window.jEditId = eid; // giữ nguyên form để người dùng sửa và gửi lại
    } finally { busy = false; }
  };

  /* ---- admin duyệt hồ sơ ---- */
  async function review(id, act, body) {
    try { const r = await api('POST', `/api/admin/submissions/${id}/${act}`, body || {}); const i = SUBS.findIndex(x => x.id === id); if (i >= 0) unpublishSub(SUBS[i]); r.sub.muaIds = []; if (i >= 0) SUBS[i] = r.sub; else SUBS.push(r.sub); if (r.sub.status === 'approved') publishSub(r.sub); render(); return true; }
    catch (e) { fail(e); }
  }
  window.admOk = id => review(id, 'approve').then(ok => ok && toast('Đã duyệt & đăng hồ sơ ✨'));
  window.admNo = id => { const el = document.getElementById('rs' + id), r = (el && el.value || '').trim(); if (r.length < 5) return jerr(el, 'Vui lòng nhập lý do từ chối (ít nhất 5 ký tự).'); review(id, 'reject', { reason: r }).then(ok => ok && toast('Đã từ chối hồ sơ')); };
  window.admDown = id => review(id, 'unpublish').then(ok => ok && toast('Đã gỡ hồ sơ'));

  /* ---- tài khoản: tên, ảnh đại diện, mật khẩu ---- */
  window.handleAvatarSelect = e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; rdF(f, async d => { try { const r = await api('PUT', '/api/me', { avatar: d }); currentUser.avatar = r.user.avatar; toast('Đã cập nhật ảnh đại diện ✨'); render(); } catch (x) { fail(x); } }); };
  window.abRmAv = async () => { try { await api('PUT', '/api/me', { avatar: null }); currentUser.avatar = ''; toast('Đã xóa ảnh đại diện'); render(); } catch (e) { fail(e); } };
  window.abSaveInfo = async () => {
    const el = document.getElementById('abName'), name = el.value.trim(); jerr(el, ''); if (name.length < 2) return jerr(el, 'Tên hiển thị cần ít nhất 2 ký tự.');
    try { const r = await api('PUT', '/api/me', { name }); currentUser.name = r.user.name; toast('Đã lưu thay đổi ✨'); render(); } catch (e) { fail(e); }
  };
  window.abSavePass = async () => {
    const g = id => document.getElementById(id), o = g('abOld').value, n = g('abNew').value, n2 = g('abNew2').value; let ok = true; const bad = (id, m) => { jerr(g(id), m); ok = false; };
    ['abOld', 'abNew', 'abNew2'].forEach(i => jerr(g(i), ''));
    if (n.length < 6) bad('abNew', 'Mật khẩu mới cần ít nhất 6 ký tự.'); else if (n === o) bad('abNew', 'Mật khẩu mới phải khác mật khẩu hiện tại.'); if (n2 !== n) bad('abNew2', 'Mật khẩu nhập lại chưa khớp.'); if (!ok) return;
    try { await api('POST', '/api/me/password', { old: o, new: n }); ['abOld', 'abNew', 'abNew2'].forEach(i => g(i).value = ''); toast('Đã đổi mật khẩu ✨'); } catch (e) { bad('abOld', e.message); }
  };
  const _ra = window.renderAbout; // tên đăng nhập = Gmail đã đăng ký → khoá, bỏ ô Email trùng lặp; server cũng từ chối nếu ai cố đổi
  window.renderAbout = () => _ra()
    .replace('Cập nhật cách bạn hiển thị và đăng nhập trên Glow Base.', 'Bạn có thể đổi tên hiển thị. Tên đăng nhập chính là Gmail đã đăng ký nên không thể thay đổi.')
    .replace('<label>Tên đăng nhập</label>', '<label>Tên đăng nhập (Gmail)</label>')
    .replace(/<label>Email<\/label><input type="email" id="abMail"[^>]*>/, '')
    .replace('id="abUser"', 'id="abUser" disabled readonly');

  /* ---- yêu thích: lưu trên server theo tài khoản (cập nhật ngay trên giao diện, lỗi thì đồng bộ lại từ server) ---- */
  let favQ = Promise.resolve();
  window.toggleFav = id => {
    if (!currentUser) { openModal('login'); return; }
    const uid = currentUser.id, list = favorites[uid] || [], had = list.includes(id);
    favorites[uid] = had ? list.filter(x => x !== id) : [...list, id];
    toast(had ? 'Đã bỏ yêu thích ♡' : 'Đã lưu vào danh sách ♡'); render();
    favQ = favQ.then(async () => {
      try { await (had ? api('DELETE', '/api/favorites/' + id) : api('PUT', '/api/favorites/' + id, {})); }
      catch (e) { fail(e); try { favorites[uid] = (await api('GET', '/api/favorites')).favs; } catch {} if (currentUser && currentUser.id === uid) render(); }
    });
  };

  /* ---- đánh giá: lưu trên server; ảnh được thu nhỏ trước khi gửi ---- */
  let fbBusy = false;
  window.handlePhotoSelect = e => {
    const files = Array.from(e.target.files || []).slice(0, 6 - fbPhotoData.length); e.target.value = '';
    files.forEach(f => rdF(f, d => { if (fbPhotoData.length < 6) { fbPhotoData.push(d); renderPhotoPreview(); } }));
  };
  window.submitFeedback = async (muaId, editId) => {
    if (fbBusy) return;
    const val = +(document.getElementById('starPicker').dataset.val || 0), text = document.getElementById('fbText').value.trim();
    if (!val) return toast('Vui lòng chọn số sao đánh giá'); if (!text) return toast('Vui lòng nhập nội dung feedback'); if (text.length > 2000) return toast('Nhận xét tối đa 2000 ký tự.');
    fbBusy = true;
    try {
      const body = { rating: val, comment: text, photos: [...fbPhotoData] };
      const r = editId ? await api('PUT', '/api/reviews/' + editId, body) : await api('POST', '/api/reviews', { ...body, mid: muaId });
      const i = feedbacks.findIndex(f => f.id === r.review.id); if (i >= 0) feedbacks[i] = r.review; else feedbacks.push(r.review);
      fbPhotoData = []; closeModal(); toast(editId ? 'Đã cập nhật đánh giá.' : 'Đánh giá của bạn đã được đăng ✨'); render();
    } catch (e) { fail(e); } finally { fbBusy = false; }
  };
  window.deleteFeedback = async id => {
    try { await api('DELETE', '/api/reviews/' + id); feedbacks = feedbacks.filter(f => f.id !== id); closeModal(); toast('Đã xóa đánh giá.'); render(); } catch (e) { fail(e); }
  };

  /* ---- admin: xoá concept / artist trên server (mọi người và mọi thiết bị đều thấy) ---- */
  async function serverDelete(ids) { await api('POST', '/api/admin/concepts/delete', { ids }); await boot(); }
  window.admDelConcept = id => { if (!isAdmin()) return;
    askConfirm('Xoá concept này? Hành động không thể hoàn tác.', async () => { try { await serverDelete([+id]); toast('Đã xoá concept'); if (route.page === 'detail') go('explore'); } catch (e) { fail(e); } }); };
  window.admDelArtist = id => { const m = byId(id); if (!isAdmin() || !m) return;
    askConfirm(`Xoá artist “${m.name}” cùng tất cả concept? Hành động không thể hoàn tác.`, async () => { try { await serverDelete(muas.filter(x => x.name === m.name).map(x => x.id)); toast('Đã xoá artist'); if (route.page === 'artist') go('explore'); } catch (e) { fail(e); } }); };
  async function migrateLocalDeletes() { // admin từng xoá khi chưa có server: đẩy các xoá cũ (lưu trong trình duyệt) lên server một lần rồi dọn
    if (!currentUser || currentUser.role !== 'admin') return;
    let ids = []; try { ids = JSON.parse(ls.get('gb_del_v5') || '[]'); } catch {}
    if (ls.get('gb_del_v5') === null) return;
    ids = ids.filter(i => Number.isInteger(i) && i > 0 && i <= 999999);
    if (ids.length) { try { await api('POST', '/api/admin/concepts/delete', { ids }); } catch (e) { return fail(e); } }
    ls.del('gb_del_v5'); if (ids.length) { toast('Đã đồng bộ ' + ids.length + ' concept đã xoá trước đó lên server'); await boot(); }
  }

  /* ---- MUA sửa hồ sơ đã duyệt → hồ sơ tạm ẩn khỏi trang công khai tới khi admin duyệt lại (server tự đặt lại "chờ duyệt") ---- */
  const _editSub = window.editSub;
  window.gbEdit = id => _editSub(id);
  window.editSub = id => { const s = subBy(id); if (!s || s.status !== 'approved') return _editSub(id);
    document.getElementById('modalRoot').innerHTML = `<div class="overlay" onclick="if(event.target===this)closeModal()"><div class="modal confirm-box"><h2 style="font-size:20px;color:var(--text)">Sửa hồ sơ đã được duyệt?</h2><div class="sub">Khi bạn gửi bản chỉnh sửa, hồ sơ sẽ <b>tạm ẩn khỏi trang công khai</b> cho đến khi admin duyệt lại (24–48 giờ). Nếu bạn chỉ xem lại thông tin rồi thoát mà không gửi thì hồ sơ vẫn hiển thị bình thường.</div><div class="confirm-actions"><button class="btn btn-ghost" onclick="closeModal()">Hủy</button><button class="btn btn-primary" onclick="closeModal();gbEdit('${id}')">Tiếp tục sửa</button></div></div></div>`; };

  boot();
})();
