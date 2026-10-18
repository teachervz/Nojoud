/* ==========================================================================
   📡 الربط المباشر — مشترك بين صفحة المعلمة وصفحة الطالبات (لا تحتاجين لتعديله)
   --------------------------------------------------------------------------
   شكل البيانات في Firebase Realtime Database:
     rooms/{الغرفة}/live                 ← رقم الشريحة الحالية عند المعلمة
     rooms/{الغرفة}/answers/{شريحة}/{مجموعة} ← إجابة كل مجموعة { v, t }
     rooms/{الغرفة}/ideas/{شريحة}/{id}       ← أفكار العصف الذهني { team, text, t }
     rooms/{الغرفة}/reveal/{شريحة}          ← true عند كشف الإجابة على الأجهزة
     rooms/{الغرفة}/awarded/{شريحة}         ← true بعد منح النقاط تلقائيًا
     rooms/{الغرفة}/scores                ← نقاط المجموعات
     rooms/{الغرفة}/presence/{مجموعة}/{id}  ← الأجهزة المتصلة
   ========================================================================== */
const LIVE = (() => {
  const qs = new URLSearchParams(location.search);
  const room = String(qs.get('room') || (window.LIVE_SETTINGS||{}).room || 'class-1').trim().replace(/[.#$\[\]\/\s]+/g,'-');
  const cfg = window.FIREBASE_CONFIG || {};
  const configured = !!(cfg.apiKey && cfg.databaseURL) && !/ضعي|your-project/i.test(cfg.apiKey + cfg.databaseURL);
  const ok = configured && !!window.firebase;
  const why = !configured ? 'config' : (!window.firebase ? 'offline' : null);

  let db = null, authError = null, ready = Promise.resolve(), offset = 0;
  if (ok) {
    firebase.initializeApp(cfg);
    db = firebase.database();
    // فرق الساعة بين الجهاز والخادم — ليكون المؤقت متزامنًا على كل الأجهزة
    db.ref('.info/serverTimeOffset').on('value', s => { offset = +s.val() || 0; });
    ready = firebase.auth().signInAnonymously()
      .catch(e => { authError = e; console.warn('تعذّر تسجيل الدخول المجهول (فعّلي Anonymous من Authentication):', e); });
  }

  /* ---------- أدوات نصية ---------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const strip = h => String(h ?? '').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
  // توحيد الكتابة العربية للمقارنة: بدون تشكيل، الهمزات، التاء المربوطة، «ال»
  const norm = s => String(s ?? '').trim().toLowerCase()
    .replace(/[ً-ْـ]/g,'').replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي')
    .replace(/^ال/,'').replace(/\s+/g,' ');

  /* ---------- سؤال الآيباد لكل شريحة (حسب نوعها) ---------- */
  function taskFor(s){
    if (!s || s.student === false) return null;
    if (s.student && typeof s.student === 'object') return Object.assign({ kind:'text' }, s.student);
    switch (s.type) {
      case 'mcq':        return { kind:'choice', q:s.question, options:s.options, answer:s.answer };
      case 'recap':      return { kind:'texts', q:'أجيبي عن الأسئلة التالية:', items:s.questions.map(x=>({ label:x.kind, q:x.q, a:x.a })) };
      case 'brainstorm': return { kind:'ideas', q:s.prompt };
      case 'blanks':     return { kind:'blanks', q:'اكتبي الكلمات المفقودة:', text:s.text, words:[...s.text.matchAll(/\[(.+?)\]/g)].map(m=>m[1]) };
      case 'order':      return { kind:'order', q:s.prompt, items:s.items };
      case 'footprints': return { kind:'pick', q:s.prompt, items:s.actions, model:s.reveal };
      case 'sort':       return { kind:'sort', q:s.prompt, buckets:s.buckets, items:s.items };
      case 'reveal':     return { kind:'text', q:s.question, model:s.items.map(x=>`${x.icon} <b>${x.t}</b>`).join('<br>') };
      case 'terminal':   return { kind:'text', q:s.question, model:s.answer };
      case 'tps':        return { kind:'text', q:s.question, model:s.answers.join('<br>') };
      case 'cards':      return { kind:'text', q:s.subtitle || s.title, context:s.cards.map(c=>`${c.icon} ${c.title}`) };
      case 'tf':         return { kind:'tf', q:'صح أم خطأ؟', items:s.items };
      case 'groups':     return { kind:'text', q:s.prompt, perTeam:s.tasks };
      case 'value':      return { kind:'text', q:s.ask || s.question, model:s.items.map(x=>`${x.icon} <b>${x.t}</b>: ${x.d}`).join('<br>') };
      case 'closing':    return { kind:'rate', q:'كيف تقيّمين فهمكِ للدرس؟', items:s.rating };
    }
    return null;
  }

  /* ---------- التصحيح التلقائي: يعيد {ok,total} أو null للأسئلة المفتوحة ---------- */
  function grade(t, v){
    if (!t || v == null) return null;
    const count = (n, f) => { let ok=0; for (let i=0;i<n;i++) if (f(i)) ok++; return { ok, total:n }; };
    switch (t.kind) {
      case 'choice': return { ok: +v === t.answer ? 1 : 0, total:1 };
      case 'blanks': return count(t.words.length, i => v[i] != null && norm(v[i]) === norm(t.words[i]));
      case 'order':  return count(t.items.length, i => v[i] === i);
      case 'sort':   return count(t.items.length, i => v[i] === t.items[i].b);
      case 'tf':     return count(t.items.length, i => v[i] === t.items[i].a);
    }
    return null;
  }

  return {
    ok, why, room, ready,
    get authError(){ return authError; },
    ref: p => db.ref(`rooms/${room}/${p}`),
    ts: () => firebase.database.ServerValue.TIMESTAMP,
    now: () => Date.now() + offset,
    onConn: fn => db.ref('.info/connected').on('value', s => fn(!!s.val())),
    taskFor, grade, esc, strip, norm
  };
})();
