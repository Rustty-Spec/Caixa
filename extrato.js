// Leitura de extratos do Nubank (conta em CSV ou OFX, fatura do cartão em CSV)
(function (root) {
  'use strict';

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function semAcento(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

  function csvLinhas(texto) {
    var linhas = [], campo = '', linha = [], aspas = false;
    var sep = (texto.split('\n')[0].split(';').length > texto.split('\n')[0].split(',').length) ? ';' : ',';
    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (aspas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') aspas = false;
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === sep) { linha.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && texto[i + 1] === '\n') i++;
        linha.push(campo); campo = '';
        if (linha.some(function (x) { return x.trim() !== ''; })) linhas.push(linha);
        linha = [];
      } else campo += c;
    }
    linha.push(campo);
    if (linha.some(function (x) { return x.trim() !== ''; })) linhas.push(linha);
    return linhas;
  }

  function numero(v) {
    v = String(v).trim().replace(/R\$|\s/g, '');
    if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function data(v) {
    v = String(v).trim();
    var m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1];
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = v.match(/^(\d{4})(\d{2})(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return null;
  }

  // Encurta descrições longas do Nubank: "Transferência enviada pelo Pix - FULANO - •••.123..." vira "Pix enviado — Fulano"
  function limpar(desc) {
    var partes = String(desc || '').split(' - ').map(function (p) { return p.trim(); }).filter(Boolean);
    var tipo = partes[0] || '', quem = partes[1] || '';
    if (/[•*]{2,}|^\d/.test(quem)) quem = '';
    var t = semAcento(tipo);
    if (/pix/.test(t) && /recebid/.test(t)) tipo = 'Pix recebido';
    else if (/pix/.test(t) && /enviad/.test(t)) tipo = 'Pix enviado';
    else if (/transferencia recebida/.test(t)) tipo = 'Transferência recebida';
    else if (/transferencia enviada/.test(t)) tipo = 'Transferência enviada';
    else if (/compra no debito/.test(t)) tipo = 'Compra no débito';
    else if (/pagamento de boleto/.test(t)) tipo = 'Boleto pago';
    if (quem) quem = quem.toLowerCase().replace(/(^|\s)\S/g, function (x) { return x.toUpperCase(); });
    var r = quem ? tipo + ' — ' + quem : tipo;
    return r.length > 80 ? r.slice(0, 77) + '…' : r;
  }

  var REGRAS = [
    [/aluguel|imobiliaria|condominio/, 'Aluguel'],
    [/energia|enel|cemig|copel|celesc|coelba|light|equatorial|neoenergia|sabesp|saneamento|agua|caesb|copasa|internet|vivo|claro|tim |oi |telefon|net servicos/, 'Contas'],
    [/das |simples nacional|darf|imposto|receita federal|prefeitura|iptu|ipva|inss|fgts|gps /, 'Impostos'],
    [/posto|combustivel|shell|ipiranga|petrobras|br mania|uber|99app|99 pop|estacionamento|pedagio|sem parar|conectcar|veloe/, 'Transporte'],
    [/atacad|distribuidora|fornecedor|deposito|assai|makro|atacadao/, 'Fornecedores']
  ];

  function sugerir(item, funcionarios) {
    var d = semAcento(item.descOriginal);
    if (item.tipo === 'out') {
      for (var i = 0; i < (funcionarios || []).length; i++) {
        var f = funcionarios[i], nome = semAcento(f.nome).trim();
        if (!nome) continue;
        var pedacos = nome.split(/\s+/);
        var chave = pedacos.length > 1 ? pedacos[0] + ' ' + pedacos[pedacos.length - 1] : pedacos[0];
        if (d.indexOf(nome) >= 0 || (pedacos.length > 1 && d.indexOf(pedacos[0]) >= 0 && d.indexOf(pedacos[pedacos.length - 1]) >= 0) || d.indexOf(chave) >= 0) {
          return { cat: 'Salários', func: f.id };
        }
      }
      for (var j = 0; j < REGRAS.length; j++) if (REGRAS[j][0].test(d)) return { cat: REGRAS[j][1] };
      return { cat: 'Outras saídas' };
    }
    if (/estorno|reembolso|rendimento/.test(d)) return { cat: 'Outras entradas' };
    return { cat: 'Vendas' };
  }

  function lerOFX(texto) {
    var out = [];
    var blocos = texto.split(/<STMTTRN>/i).slice(1);
    blocos.forEach(function (b) {
      function tag(n) { var m = b.match(new RegExp('<' + n + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; }
      var v = numero(tag('TRNAMT')), d = data(tag('DTPOSTED'));
      if (v == null || !d || v === 0) return;
      var desc = tag('MEMO') || tag('NAME');
      out.push({ data: d, valor: Math.abs(v), tipo: v < 0 ? 'out' : 'in', descOriginal: desc, idBanco: tag('FITID') });
    });
    return out;
  }

  function lerCSV(texto) {
    var L = csvLinhas(texto);
    if (L.length < 2) return [];
    var cab = L[0].map(function (h) { return semAcento(h).trim(); });
    function col(nomes) { for (var i = 0; i < cab.length; i++) if (nomes.indexOf(cab[i]) >= 0) return i; return -1; }
    var iData = col(['data', 'date']), iValor = col(['valor', 'amount']), iDesc = col(['descricao', 'title', 'descrição']), iId = col(['identificador', 'id']);
    if (iData < 0 || iValor < 0) throw new Error('formato');
    var cartao = cab.indexOf('amount') >= 0 && cab.indexOf('title') >= 0; // fatura do cartão: valor positivo é gasto
    var out = [];
    L.slice(1).forEach(function (r) {
      var v = numero(r[iValor]), d = data(r[iData]);
      if (v == null || !d || v === 0) return;
      var neg = cartao ? v > 0 : v < 0;
      out.push({ data: d, valor: Math.round(Math.abs(v) * 100) / 100, tipo: neg ? 'out' : 'in', descOriginal: iDesc >= 0 ? r[iDesc] : '', idBanco: iId >= 0 ? r[iId] : '' });
    });
    return out;
  }

  function ler(texto, nomeArquivo, funcionarios) {
    texto = String(texto || '').replace(/^﻿/, '');
    var itens = /<OFX>|<STMTTRN>/i.test(texto) || /\.ofx$/i.test(nomeArquivo || '') ? lerOFX(texto) : lerCSV(texto);
    var vistos = {};
    return itens.map(function (it) {
      var base = it.idBanco ? 'id:' + it.idBanco : it.data + '|' + it.valor + '|' + it.tipo + '|' + it.descOriginal;
      var n = (vistos[base] = (vistos[base] || 0) + 1);
      it.chave = 'nu_' + hash(base + (n > 1 ? '#' + n : ''));
      it.desc = limpar(it.descOriginal) || (it.tipo === 'in' ? 'Entrada' : 'Saída');
      var s = sugerir(it, funcionarios);
      it.cat = s.cat; if (s.func) it.func = s.func;
      // movimentos entre contas do próprio dono (fatura, guardar dinheiro) começam desmarcados
      it.interno = /pagamento recebido|pagamento de fatura|pagamento da fatura|aplicacao rdb|resgate rdb|dinheiro guardado|dinheiro resgatado|caixinha/.test(semAcento(it.descOriginal));
      return it;
    }).sort(function (a, b) { return a.data.localeCompare(b.data); });
  }

  // usado pela sincronização automática (Pluggy)
  function classificar(it, funcionarios) {
    it.desc = limpar(it.descOriginal) || (it.tipo === 'in' ? 'Entrada' : 'Saída');
    var s = sugerir(it, funcionarios);
    it.cat = s.cat; if (s.func) it.func = s.func;
    it.interno = /pagamento recebido|pagamento de fatura|pagamento da fatura|aplicacao rdb|resgate rdb|dinheiro guardado|dinheiro resgatado|caixinha/.test(semAcento(it.descOriginal));
    return it;
  }

  root.Extrato = { ler: ler, classificar: classificar };
  if (typeof module !== 'undefined') module.exports = root.Extrato;
})(typeof window !== 'undefined' ? window : globalThis);
