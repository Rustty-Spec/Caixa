// Puxa as transações do Nubank pela Pluggy e deixa em "pendentes" para conferir no app.
const admin = require('firebase-admin');
const Extrato = require('../extrato.js');

const API = 'https://api.pluggy.ai';
const { PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_ID, FIREBASE_SA, SYNC_DESDE } = process.env;
for (const [k, v] of Object.entries({ PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET, PLUGGY_ITEM_ID, FIREBASE_SA })) {
  if (!v) { console.log(`Ainda falta o segredo ${k} no GitHub (Settings → Secrets and variables → Actions). Nada a fazer.`); process.exit(0); }
}

async function chamar(caminho, apiKey, opcoes = {}) {
  const r = await fetch(API + caminho, { ...opcoes, headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}), ...(opcoes.headers || {}) } });
  const texto = await r.text();
  let corpo; try { corpo = JSON.parse(texto); } catch { corpo = texto; }
  if (!r.ok) { const e = new Error(`${r.status} em ${caminho}: ${texto.slice(0, 300)}`); e.status = r.status; throw e; }
  return corpo;
}

async function transacoes(apiKey, accountId, from, to) {
  const todas = [];
  try {
    let cursor = null, voltas = 0;
    do {
      const q = new URLSearchParams({ accountId, from, to, pageSize: '500' });
      if (cursor) q.set('cursor', cursor);
      const r = await chamar('/v2/transactions?' + q, apiKey);
      todas.push(...(r.results || []));
      cursor = r.next || r.nextCursor || r.cursor || (r.pagination && (r.pagination.next || r.pagination.cursor)) || null;
    } while (cursor && ++voltas < 50);
    return todas;
  } catch (e) {
    if (![400, 404, 405].includes(e.status)) throw e;
    console.log('v2/transactions indisponível, usando /transactions:', e.message.slice(0, 120));
  }
  let page = 1, total = 1;
  do {
    const q = new URLSearchParams({ accountId, from, to, pageSize: '500', page: String(page) });
    const r = await chamar('/transactions?' + q, apiKey);
    todas.push(...(r.results || []));
    total = r.totalPages || 1;
  } while (++page <= total && page < 50);
  return todas;
}

function dia(d) { return new Date(d).toISOString().slice(0, 10); }

(async () => {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(FIREBASE_SA)) });
  const db = admin.firestore();

  const hoje = new Date();
  const ini = new Date(hoje.getTime() - 35 * 864e5);
  const desde = SYNC_DESDE && SYNC_DESDE > dia(ini) ? SYNC_DESDE : dia(ini);
  const ate = dia(new Date(hoje.getTime() + 864e5));

  const { apiKey } = await chamar('/auth', null, { method: 'POST', body: JSON.stringify({ clientId: PLUGGY_CLIENT_ID, clientSecret: PLUGGY_CLIENT_SECRET }) });
  const contas = (await chamar('/accounts?itemId=' + encodeURIComponent(PLUGGY_ITEM_ID), apiKey)).results || [];
  console.log('Contas encontradas:', contas.map(c => `${c.type} ${c.name || ''}`.trim()).join(', ') || 'nenhuma');

  const funcionarios = (await db.collection('funcionarios').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const lancs = (await db.collection('lancamentos').where('data', '>=', desde).get()).docs;
  const jaLancado = new Set(lancs.map(d => d.id));
  // evita duplicar o que entrou pela importação manual de extrato
  const manual = new Set(lancs.filter(d => d.id.startsWith('nu_')).map(d => { const x = d.data(); return `${x.data}|${x.valor}|${x.tipo}`; }));
  const pend = new Set((await db.collection('pendentes').get()).docs.map(d => d.id));

  let novos = 0, batch = db.batch(), ops = 0;
  for (const c of contas) {
    const cartao = c.type === 'CREDIT';
    const lista = await transacoes(apiKey, c.id, desde, ate);
    for (const t of lista) {
      if (t.status && String(t.status).toUpperCase() === 'PENDING') continue;
      const valor = Math.round(Math.abs(Number(t.amount)) * 100) / 100;
      if (!valor) continue;
      const tipo = cartao ? (t.type === 'CREDIT' ? 'in' : 'out') : (t.type === 'DEBIT' || Number(t.amount) < 0 ? 'out' : 'in');
      const id = 'pg_' + String(t.id).replace(/[^A-Za-z0-9_-]/g, '');
      if (jaLancado.has(id) || pend.has(id)) continue;
      const it = Extrato.classificar({ data: dia(t.date), valor, tipo, descOriginal: t.description || t.descriptionRaw || '' }, funcionarios);
      if (manual.has(`${it.data}|${it.valor}|${it.tipo}`)) continue;
      const doc = { data: it.data, valor, tipo, desc: (cartao ? 'Cartão: ' : '') + it.desc, descOriginal: it.descOriginal, cat: it.cat, interno: !!it.interno, conta: cartao ? 'Cartão' : 'Conta', criado: admin.firestore.FieldValue.serverTimestamp() };
      if (it.func) doc.func = it.func;
      batch.set(db.collection('pendentes').doc(id), doc); novos++;
      if (++ops === 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
  }
  if (ops) await batch.commit();
  console.log(`Pronto: ${novos} movimentações novas para conferir (período ${desde} a ${ate}).`);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
