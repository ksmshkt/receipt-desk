let currentReceiptId = null;
let currentImagePath = null;
let allReceipts = [];
let addItems = [];
let addBusy = false;

const CATEGORY_OPTIONS = ['会議費', '交通費', '消耗品費', '通信費', '接待交際費', '研修費', '広告宣伝費', 'その他'];

// supabase-js only gives a generic message for non-2xx Edge Function responses
// (e.g. "Edge Function returned a non-2xx status code") — the actual
// { error: "..." } body we send back (like the OCR quota message) has to be
// read separately off err.context.
async function extractFunctionErrorMessage(err) {
  if (err?.context?.json) {
    try {
      const body = await err.context.json();
      if (body?.error) return body.error;
    } catch {}
  }
  return err.message || String(err);
}

// Mirrors ocr-receipt/index.ts's PLAN_LIMITS for display purposes. Deno (Edge
// Function) and the browser can't share a module here, so this small table is
// intentionally duplicated — add a plan to both places when introducing one.
const PLAN_LABELS = { free: '無料プラン', admin: '管理者プラン' };
const PLAN_LIMITS_DISPLAY = { free: 30, admin: null };

// Mirrors ocr-receipt/index.ts's currentMonthKey() (same JST-vs-UTC reasoning).
function currentMonthKeyJST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  return `${year}-${month}`;
}

async function loadAccountUsage() {
  const { data: { user } } = await client.auth.getUser();
  const { data: profile } = await client
    .from('receipt_desk_profiles')
    .select('plan, ocr_month, ocr_count')
    .eq('user_id', user.id)
    .maybeSingle();

  const plan = profile?.plan ?? 'free';
  // `in` (not `??`) so admin's legitimate `null` (unlimited) isn't mistaken for "missing".
  const limit = plan in PLAN_LIMITS_DISPLAY ? PLAN_LIMITS_DISPLAY[plan] : PLAN_LIMITS_DISPLAY.free;
  const count = profile?.ocr_month === currentMonthKeyJST() ? profile.ocr_count : 0;

  document.getElementById('account-plan-label').textContent = PLAN_LABELS[plan] ?? plan;
  document.getElementById('account-usage-label').textContent =
    limit === null ? `OCR利用状況：${count}件（無制限）` : `OCR利用状況：${count} / ${limit}件（今月）`;
}

async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  await loadReceipts();
  await loadAccountUsage();

  const receiptId = new URLSearchParams(window.location.search).get('receipt');
  if (receiptId) {
    document.querySelector('.tab[data-tab="list"]').click();
    await openReceipt(receiptId);
  }
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    if (tab.dataset.tab === 'list') loadReceipts();
  });
});

// Account menu (icon opens a popover with plan/usage info + logout/delete-account)
document.getElementById('account-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('account-menu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  const menu = document.getElementById('account-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'account-btn') {
    menu.classList.add('hidden');
  }
});

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？')) return;
  await client.auth.signOut();
  window.location.href = 'index.html';
});

// Delete account (irreversible — double confirm)
document.getElementById('delete-account-btn').addEventListener('click', async () => {
  if (!confirm('アカウントを削除すると、保存した全レシート・画像が完全に削除され元に戻せません。続けますか？')) return;
  if (!confirm('本当によろしいですか？この操作は取り消せません。')) return;

  showLoading(true);
  try {
    const { error } = await client.functions.invoke('delete-account');
    if (error) throw error;
    await client.auth.signOut();
    window.location.href = 'index.html';
  } catch (err) {
    alert('退会処理に失敗しました: ' + (await extractFunctionErrorMessage(err)));
  } finally {
    showLoading(false);
  }
});

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function escapeHtmlAttr(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeFilename(str) {
  return (str || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}

function buildSelectOptions(options, selectedValue) {
  return '<option value="">未選択</option>' + options.map(opt =>
    `<option value="${escapeHtmlAttr(opt)}" ${opt === selectedValue ? 'selected' : ''}>${escapeHtmlAttr(opt)}</option>`
  ).join('');
}

function statusBadge(status) {
  switch (status) {
    case 'pending': return { label: '未読取', cls: 'badge-pending' };
    case 'running': return { label: '読取中...', cls: 'badge-running' };
    case 'done': return { label: '読取済み', cls: 'badge-done' };
    case 'error': return { label: '読取エラー', cls: 'badge-error' };
    default: return { label: '', cls: '' };
  }
}

// File selection: append (never reset), each item starts fully editable with no OCR run yet
document.getElementById('image-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  e.target.value = ''; // allow re-selecting the same file(s) later

  showLoading(true);
  try {
    for (let i = 0; i < files.length; i++) {
      const blob = await compressImage(files[i]);
      addItems.push({
        id: `add-${Date.now()}-${i}`,
        blob,
        previewUrl: URL.createObjectURL(blob),
        ocrStatus: 'pending',
        ocrError: null,
        selected: true,
        fields: {
          date: '',
          store_name: '',
          amount: null,
          is_qualified: true,
          tax_rate: 10,
          category: '',
          payment_method: '',
          memo: '',
        },
      });
    }
  } finally {
    showLoading(false);
  }
  renderAddList();
});

function renderAddRowHtml(item) {
  const badge = statusBadge(item.ocrStatus);
  return `
    <div class="receipt-row" data-add-id="${item.id}">
      <div class="receipt-row-header">
        <input type="checkbox" class="receipt-row-select" data-action="select" ${item.selected ? 'checked' : ''}>
        <img class="receipt-row-thumb" src="${item.previewUrl}" alt="レシート画像" data-action="preview">
        <span class="badge ${badge.cls}">${badge.label}</span>
        <button type="button" class="btn-danger receipt-row-remove" data-action="remove">除外</button>
      </div>
      <div class="form-group">
        <label>日付</label>
        <input type="date" data-field="date" value="${item.fields.date || ''}">
      </div>
      <div class="form-group">
        <label>店名・取引先</label>
        <input type="text" data-field="store_name" value="${escapeHtmlAttr(item.fields.store_name)}" placeholder="例：スターバックス">
      </div>
      <div class="form-group">
        <label>金額（円）</label>
        <input type="number" min="0" data-field="amount" value="${item.fields.amount ?? ''}" placeholder="例：1500">
      </div>
      <div class="form-group">
        <label>勘定科目</label>
        <select data-field="category">${buildSelectOptions(CATEGORY_OPTIONS, item.fields.category)}</select>
      </div>
      <button type="button" class="btn-ghost receipt-row-detail-toggle" data-action="toggle-detail">詳細を編集 ▼</button>
      <div class="receipt-row-detail hidden">
        <div class="form-group">
          <label>適格請求書（インボイス）</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="qualified-${item.id}" data-field="is_qualified" value="true" ${item.fields.is_qualified ? 'checked' : ''}> 適格</label>
            <label class="radio-label"><input type="radio" name="qualified-${item.id}" data-field="is_qualified" value="false" ${!item.fields.is_qualified ? 'checked' : ''}> 非適格</label>
          </div>
        </div>
        <div class="form-group">
          <label>消費税率</label>
          <div class="radio-group">
            <label class="radio-label"><input type="radio" name="tax-${item.id}" data-field="tax_rate" value="10" ${item.fields.tax_rate === 10 ? 'checked' : ''}> 10%</label>
            <label class="radio-label"><input type="radio" name="tax-${item.id}" data-field="tax_rate" value="8" ${item.fields.tax_rate === 8 ? 'checked' : ''}> 8%（軽減税率）</label>
          </div>
        </div>
        <div class="form-group">
          <label>取引手段</label>
          <input type="text" data-field="payment_method" value="${escapeHtmlAttr(item.fields.payment_method)}" placeholder="例：現金、事業用カード">
        </div>
        <div class="form-group">
          <label>摘要</label>
          <input type="text" data-field="memo" value="${escapeHtmlAttr(item.fields.memo)}" placeholder="任意">
        </div>
        ${item.ocrStatus === 'error' ? `<p class="error-msg">自動読み取りに失敗しました：${escapeHtmlAttr(item.ocrError || '')}</p>` : ''}
      </div>
    </div>
  `;
}

function renderAddList() {
  document.getElementById('add-list').innerHTML = addItems.map(renderAddRowHtml).join('');
  updateAddToolbar();
}

function renderAddRow(id) {
  const item = addItems.find(it => it.id === id);
  const el = document.querySelector(`.receipt-row[data-add-id="${id}"]`);
  if (!item || !el) return;
  el.outerHTML = renderAddRowHtml(item);
}

function updateAddRowBadge(id) {
  const item = addItems.find(it => it.id === id);
  const el = document.querySelector(`.receipt-row[data-add-id="${id}"]`);
  if (!item || !el) return;
  const badge = statusBadge(item.ocrStatus);
  const badgeEl = el.querySelector('.badge');
  badgeEl.className = `badge ${badge.cls}`;
  badgeEl.textContent = badge.label;
}

function updateAddToolbar() {
  const toolbar = document.getElementById('add-toolbar');
  const saveBtn = document.getElementById('add-save-btn');
  const bulkRow = document.getElementById('bulk-apply-row');

  if (!addItems.length) {
    toolbar.classList.add('hidden');
    saveBtn.classList.add('hidden');
    bulkRow.classList.add('hidden');
    return;
  }

  const selectedCount = addItems.filter(it => it.selected).length;

  toolbar.classList.remove('hidden');
  saveBtn.classList.remove('hidden');
  document.getElementById('add-count-label').textContent = `${selectedCount}件選択中`;
  saveBtn.disabled = selectedCount === 0;
  bulkRow.classList.toggle('hidden', selectedCount < 2);
}

function removeAddItem(id) {
  if (addBusy) return;
  const idx = addItems.findIndex(it => it.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(addItems[idx].previewUrl);
  addItems.splice(idx, 1);
  renderAddList();
}

// Event delegation for dynamically rendered rows
document.getElementById('add-list').addEventListener('click', (e) => {
  const row = e.target.closest('.receipt-row');
  if (!row) return;
  const id = row.dataset.addId;

  if (e.target.dataset.action === 'remove') {
    removeAddItem(id);
  } else if (e.target.dataset.action === 'toggle-detail') {
    const detail = row.querySelector('.receipt-row-detail');
    const willShow = detail.classList.contains('hidden');
    detail.classList.toggle('hidden');
    e.target.textContent = willShow ? '詳細を閉じる ▲' : '詳細を編集 ▼';
  } else if (e.target.dataset.action === 'select') {
    const item = addItems.find(it => it.id === id);
    if (item) item.selected = e.target.checked;
    updateAddToolbar();
  } else if (e.target.dataset.action === 'preview') {
    const item = addItems.find(it => it.id === id);
    if (item) openImageLightbox(item.previewUrl);
  }
});

// Bulk apply: pick one field, set its value (blank included), apply to every
// currently-selected row. Only the chosen field is touched — unlike a single
// multi-field form, there's no ambiguity between "left blank" and "not touched",
// since choosing the field IS the opt-in signal.
// Kept as its own function (rather than inlined in the click handler) so a future
// rule-matching feature can call the same entry point instead of duplicating this logic.
document.getElementById('bulk-apply-value-select').innerHTML = buildSelectOptions(CATEGORY_OPTIONS, '');

function applyFieldsToItems(ids, fields) {
  ids.forEach(id => {
    const item = addItems.find(it => it.id === id);
    if (!item) return;
    Object.keys(fields).forEach(key => { item.fields[key] = fields[key]; });
    renderAddRow(id);
  });
}

document.getElementById('bulk-apply-field').addEventListener('change', (e) => {
  const field = e.target.value;
  const valueSelect = document.getElementById('bulk-apply-value-select');
  const valueText = document.getElementById('bulk-apply-value-text');
  const applyBtn = document.getElementById('bulk-apply-btn');

  valueSelect.value = '';
  valueText.value = '';

  if (!field) {
    valueSelect.classList.add('hidden');
    valueText.classList.add('hidden');
    applyBtn.classList.add('hidden');
  } else if (field === 'category') {
    valueSelect.classList.remove('hidden');
    valueText.classList.add('hidden');
    applyBtn.classList.remove('hidden');
  } else {
    valueSelect.classList.add('hidden');
    valueText.classList.remove('hidden');
    applyBtn.classList.remove('hidden');
  }
});

document.getElementById('bulk-apply-btn').addEventListener('click', () => {
  const field = document.getElementById('bulk-apply-field').value;
  if (!field) return;

  const value = field === 'category'
    ? document.getElementById('bulk-apply-value-select').value
    : document.getElementById('bulk-apply-value-text').value;

  const selectedIds = addItems.filter(it => it.selected).map(it => it.id);
  if (!selectedIds.length) return;
  applyFieldsToItems(selectedIds, { [field]: value });

  // Reset the picker for the next field, but leave row selection (checkboxes) untouched
  // so multiple fields can be applied to the same batch in sequence.
  document.getElementById('bulk-apply-field').value = '';
  document.getElementById('bulk-apply-field').dispatchEvent(new Event('change'));
});

function openImageLightbox(url) {
  document.getElementById('lightbox-image').src = url;
  document.getElementById('image-lightbox').classList.remove('hidden');
}

function closeImageLightbox() {
  document.getElementById('image-lightbox').classList.add('hidden');
  document.getElementById('lightbox-image').src = '';
}

document.getElementById('image-lightbox').addEventListener('click', closeImageLightbox);

function handleAddFieldInput(e) {
  const field = e.target.dataset.field;
  if (!field) return;
  const row = e.target.closest('.receipt-row');
  const item = row && addItems.find(it => it.id === row.dataset.addId);
  if (!item) return;

  if (field === 'is_qualified') {
    item.fields.is_qualified = e.target.value === 'true';
  } else if (field === 'tax_rate') {
    item.fields.tax_rate = parseInt(e.target.value, 10);
  } else if (field === 'amount') {
    item.fields.amount = e.target.value ? parseInt(e.target.value, 10) : null;
  } else {
    item.fields[field] = e.target.value;
  }
}
document.getElementById('add-list').addEventListener('input', handleAddFieldInput);
document.getElementById('add-list').addEventListener('change', handleAddFieldInput);

// Manual, sequential OCR — only ever runs on pending/error items, so re-running after
// appending more files doesn't re-process already-read rows
async function runOcrForPendingItems() {
  const idsToProcess = addItems.filter(it => it.ocrStatus === 'pending' || it.ocrStatus === 'error').map(it => it.id);
  if (!idsToProcess.length) return;

  addBusy = true;
  document.getElementById('add-ocr-btn').disabled = true;
  document.getElementById('add-save-btn').disabled = true;
  const countLabel = document.getElementById('add-count-label');

  for (let i = 0; i < idsToProcess.length; i++) {
    const item = addItems.find(it => it.id === idsToProcess[i]);
    if (!item) continue; // removed mid-run

    countLabel.textContent = `${i + 1}/${idsToProcess.length}件 読み取り中...`;
    item.ocrStatus = 'running';
    item.ocrError = null;
    updateAddRowBadge(item.id);

    try {
      const base64 = await blobToBase64(item.blob);
      const { data, error } = await client.functions.invoke('ocr-receipt', {
        body: { image_base64: base64, media_type: 'image/jpeg' },
      });
      if (error) throw error;
      if (data.date) item.fields.date = data.date;
      if (data.store_name) item.fields.store_name = data.store_name;
      if (data.amount != null) item.fields.amount = data.amount;
      if (data.is_qualified != null) item.fields.is_qualified = data.is_qualified;
      if (data.tax_rate != null) item.fields.tax_rate = data.tax_rate;
      if (data.payment_method) item.fields.payment_method = data.payment_method;
      item.ocrStatus = 'done';
    } catch (err) {
      item.ocrStatus = 'error';
      item.ocrError = await extractFunctionErrorMessage(err);
      // fields stay at their current values — editable and savable regardless
    }
    renderAddRow(item.id);
  }

  addBusy = false;
  document.getElementById('add-ocr-btn').disabled = false;
  document.getElementById('add-save-btn').disabled = false;
  updateAddToolbar();
  loadAccountUsage();
}
document.getElementById('add-ocr-btn').addEventListener('click', runOcrForPendingItems);

// Save only the checked rows: one Storage upload per file (no bulk upload API),
// one array insert for the DB rows. Unselected rows stay in the list untouched.
async function saveAllReceipts() {
  const selectedItems = addItems.filter(it => it.selected);
  if (addBusy || !selectedItems.length) return;

  addBusy = true;
  document.getElementById('add-save-btn').disabled = true;
  document.getElementById('add-ocr-btn').disabled = true;
  const countLabel = document.getElementById('add-count-label');

  const uploadedPaths = [];
  try {
    const { data: { user } } = await client.auth.getUser();
    const total = selectedItems.length;
    const rowsToInsert = [];

    for (let i = 0; i < total; i++) {
      countLabel.textContent = `${i + 1}/${total}件 保存中...`;
      const item = selectedItems[i];

      const imagePath = `${user.id}/${Date.now()}-${i}.jpg`;
      const { error: uploadError } = await client.storage.from('receipts')
        .upload(imagePath, item.blob, { contentType: 'image/jpeg' });
      if (uploadError) throw new Error(`${i + 1}件目のアップロードに失敗しました: ${uploadError.message}`);
      uploadedPaths.push(imagePath);

      rowsToInsert.push({
        user_id: user.id,
        date: item.fields.date || null,
        store_name: item.fields.store_name || null,
        amount: item.fields.amount,
        is_qualified: item.fields.is_qualified,
        tax_rate: item.fields.tax_rate,
        category: item.fields.category || null,
        payment_method: item.fields.payment_method || null,
        memo: item.fields.memo || null,
        image_path: imagePath,
      });
    }

    const { error: insertError } = await client.from('receipts').insert(rowsToInsert);
    if (insertError) throw insertError;

    selectedItems.forEach(it => URL.revokeObjectURL(it.previewUrl));
    addItems = addItems.filter(it => !it.selected);
    renderAddList();

    if (!addItems.length) {
      document.querySelector('.tab[data-tab="list"]').click();
    } else {
      alert(`${total}件保存しました。残りのレシートは引き続き編集できます。`);
    }
  } catch (err) {
    if (uploadedPaths.length) {
      await client.storage.from('receipts').remove(uploadedPaths).catch(() => {});
    }
    alert('保存に失敗しました: ' + err.message);
  } finally {
    addBusy = false;
    document.getElementById('add-save-btn').disabled = false;
    document.getElementById('add-ocr-btn').disabled = false;
    updateAddToolbar();
  }
}
document.getElementById('add-save-btn').addEventListener('click', saveAllReceipts);

// Load receipts
async function loadReceipts() {
  const search = document.getElementById('search-input').value.trim();

  let query = client.from('receipts').select('*')
    .order('date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(`store_name.ilike.%${search}%,memo.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return;

  allReceipts = data;
  renderReceipts(data);
}

function renderReceipts(receipts) {
  const list = document.getElementById('receipt-list');
  const empty = document.getElementById('empty-state');

  if (!receipts.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = receipts.map(r => `
    <div class="receipt-card" onclick="openReceipt('${r.id}')">
      <div class="receipt-card-left">
        <div class="receipt-card-date">${r.date || '日付なし'}</div>
        <div class="receipt-card-store">${r.store_name || '店名なし'}</div>
        ${r.category ? `<div class="receipt-card-category">${r.category}</div>` : ''}
      </div>
      <div class="receipt-card-right">
        <div class="receipt-card-amount">${r.amount != null ? '¥' + r.amount.toLocaleString() : '-'}</div>
        <span class="badge ${r.is_qualified ? 'badge-qualified' : 'badge-unqualified'}">
          ${r.is_qualified ? '適格' : '非適格'}
        </span>
      </div>
    </div>
  `).join('');
}

document.getElementById('search-input').addEventListener('input', loadReceipts);

// CSV date range picker
document.getElementById('csv-range-select').addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  document.getElementById('csv-range-start').classList.toggle('hidden', !isCustom);
  document.getElementById('csv-range-tilde').classList.toggle('hidden', !isCustom);
  document.getElementById('csv-range-end').classList.toggle('hidden', !isCustom);
});

function getCsvDateRange() {
  const mode = document.getElementById('csv-range-select').value;
  if (mode === 'all') return null;

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();

  if (mode === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: fmt(start), end: fmt(end) };
  }
  if (mode === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    const start = new Date(now.getFullYear(), qStartMonth, 1);
    const end = new Date(now.getFullYear(), qStartMonth + 3, 0);
    return { start: fmt(start), end: fmt(end) };
  }
  if (mode === 'year') {
    return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` };
  }
  // custom
  return {
    start: document.getElementById('csv-range-start').value || null,
    end: document.getElementById('csv-range-end').value || null,
  };
}

// Short label for the currently selected period, used in confirm dialogs
// so it's clear at the moment of export which range is actually targeted.
function getCsvRangeLabel() {
  const mode = document.getElementById('csv-range-select').value;
  const labels = { all: 'すべての期間', month: '今月', quarter: '今四半期', year: '今年' };
  if (mode !== 'custom') return labels[mode];
  const start = document.getElementById('csv-range-start').value || '指定なし';
  const end = document.getElementById('csv-range-end').value || '指定なし';
  return `${start} 〜 ${end}`;
}

// Bulk image download (ZIP) — unlike CSV, date-less receipts (image-only
// archival) are included when no specific range is selected, since that's
// exactly the case this feature exists for.
function getImageExportList() {
  const range = getCsvDateRange();
  if (!range) return allReceipts.filter(r => r.image_path);
  return allReceipts.filter(r =>
    r.image_path && r.date && (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end)
  );
}

document.getElementById('export-images-btn').addEventListener('click', async () => {
  const exportable = getImageExportList();
  if (!exportable.length) { alert('ダウンロードする画像がありません'); return; }
  if (!confirm(`「${getCsvRangeLabel()}」の画像${exportable.length}件をZIPでダウンロードします。よろしいですか？`)) return;

  const btn = document.getElementById('export-images-btn');
  const progress = document.getElementById('image-export-progress');
  btn.disabled = true;
  progress.classList.remove('hidden');

  const zip = new JSZip();
  let skipped = 0;

  for (let i = 0; i < exportable.length; i++) {
    const r = exportable[i];
    progress.textContent = `${i + 1}/${exportable.length}件 取得中...`;

    const { data: blob, error } = await client.storage.from('receipts').download(r.image_path);
    if (error || !blob) { skipped++; continue; }

    const ext = r.image_path.split('.').pop() || 'jpg';
    const label = sanitizeFilename(`${r.date || '日付なし'}_${r.store_name || '店名なし'}_${r.id.slice(0, 8)}`);
    zip.file(`${label}.${ext}`, blob);
  }

  progress.textContent = 'ZIPを作成中...';
  const zipBlob = await zip.generateAsync({ type: 'blob' });

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipt_images_${today()}.zip`;
  a.click();
  URL.revokeObjectURL(url);

  progress.classList.add('hidden');
  btn.disabled = false;

  if (skipped) alert(`${skipped}件の画像取得に失敗したためZIPから除外しました。`);
});

// CSV形式選択のアコーディオン（account-menuと同じ開閉パターン：外側クリックで閉じる）
document.getElementById('csv-export-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('csv-export-menu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  const menu = document.getElementById('csv-export-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'csv-export-toggle') {
    menu.classList.add('hidden');
  }
});

// Shared by both CSV exports — rows missing a date aren't usable for bookkeeping
// exports, so leave them out (they still show up in the list itself).
function getCsvExportList() {
  const withDate = allReceipts.filter(r => r.date);
  const skipped = allReceipts.length - withDate.length;

  const range = getCsvDateRange();
  const exportable = range
    ? withDate.filter(r => (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end))
    : withDate;

  return { exportable, skipped };
}

// Export CSV
document.getElementById('export-csv-btn').addEventListener('click', () => {
  document.getElementById('csv-export-menu').classList.add('hidden');
  if (!allReceipts.length) { alert('エクスポートするレシートがありません'); return; }

  const { exportable, skipped } = getCsvExportList();
  if (!exportable.length) {
    alert('条件に一致するレシートがありません');
    return;
  }
  if (!confirm(`「${getCsvRangeLabel()}」のレシート${exportable.length}件をCSVでダウンロードします。よろしいですか？`)) return;

  const headers = ['日付', '店名・取引先', '金額', '適格請求書', '消費税率', '勘定科目', '取引手段', '摘要', '画像リンク'];
  const baseUrl = `${window.location.origin}${window.location.pathname}`;

  const rows = exportable.map(r => [
    r.date || '',
    r.store_name || '',
    r.amount != null ? r.amount : '',
    r.is_qualified ? '適格' : '非適格',
    r.tax_rate != null ? `${r.tax_rate}%` : '',
    r.category || '',
    r.payment_method || '',
    r.memo || '',
    r.image_path ? `${baseUrl}?receipt=${r.id}` : '',
  ]);

  const csv = [headers, ...rows].map(row => row.map(escapeCsvField).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipts_${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  if (skipped) {
    alert(`日付未入力の${skipped}件を除いてCSVを出力しました。`);
  }
});

// Export CSV for やよいの青色申告 オンライン（現金出納帳のCSV取込フォーマット）。
// 列は 日付,入金,出金,摘要,軽減税率,部門,請求書区分 の固定7列。すべて支出前提
// なので入金・部門は常に空欄。摘要は店名＋摘要をマージする（弥生側は取引先名を
// 摘要に含める運用のため）。軽減税率は「非空欄なら対象」という弥生側の仕様に
// 合わせて8%の時だけ印を入れる。請求書区分は非適格の時だけ「区分記載」を入れる
// （登録番号のない簡易な領収書＝区分記載請求書、という弥生側の用語に合わせている）。
document.getElementById('export-csv-yayoi-btn').addEventListener('click', () => {
  document.getElementById('csv-export-menu').classList.add('hidden');
  if (!allReceipts.length) { alert('エクスポートするレシートがありません'); return; }

  const { exportable, skipped } = getCsvExportList();
  if (!exportable.length) {
    alert('条件に一致するレシートがありません');
    return;
  }
  if (!confirm(`「${getCsvRangeLabel()}」のレシート${exportable.length}件をCSV（弥生形式）でダウンロードします。よろしいですか？`)) return;

  const headers = ['日付', '入金', '出金', '摘要', '軽減税率', '部門', '請求書区分'];

  const rows = exportable.map(r => [
    r.date.replaceAll('-', '/'),
    '',
    r.amount != null ? r.amount : '',
    [r.store_name, r.memo].filter(Boolean).join('　'),
    r.tax_rate === 8 ? '軽' : '',
    '',
    r.is_qualified ? '' : '区分記載',
  ]);

  const csv = [headers, ...rows].map(row => row.map(escapeCsvField).join(',')).join('\r\n');

  // 弥生のCSV取込はShift-JIS前提のため、UTF-8ではなくSJISでエンコードする。
  // Shift-JISにはアクセント付きラテン文字（例：EXCELSIOR CAFFÉ の É）が存在せず、
  // そのまま変換すると "?" に置き換わってしまうため、NFD分解して結合文字（アクセント）
  // だけを取り除き、素のアルファベットに落としてから変換する。
  // 踏んだバグ：NFD分解は「ダ」のような濁点付きカナも「タ」+結合濁点に分解してしまい、
  // 結合濁点はSJISで単独表現できず同じく "?" 化する。最後にNFCへ戻して濁点付きカナを
  // 元の合成済み文字に復元することで、ラテン文字のアクセントだけを落とす
  const normalized = csv.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  const unicodeArray = Encoding.stringToCode(normalized);
  const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' });
  const blob = new Blob([new Uint8Array(sjisArray)], { type: 'text/csv' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipts_yayoi_${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  if (skipped) {
    alert(`日付未入力の${skipped}件を除いて弥生用CSVを出力しました。`);
  }
});

function escapeCsvField(field) {
  const str = String(field);
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Open receipt modal
async function openReceipt(id) {
  const r = allReceipts.find(r => r.id === id);
  if (!r) return;

  currentReceiptId = id;
  currentImagePath = r.image_path;

  document.getElementById('modal-date').value = r.date || '';
  document.getElementById('modal-store').value = r.store_name || '';
  document.getElementById('modal-amount').value = r.amount ?? '';
  document.getElementById('modal-category').value = r.category || '';
  document.getElementById('modal-payment-method').value = r.payment_method || '';
  document.getElementById('modal-memo').value = r.memo || '';
  document.querySelectorAll('input[name="modal_qualified"]').forEach(radio => {
    radio.checked = radio.value === String(r.is_qualified);
  });
  document.querySelectorAll('input[name="modal_tax_rate"]').forEach(radio => {
    radio.checked = radio.value === String(r.tax_rate);
  });

  const imageContainer = document.getElementById('modal-image-container');
  const modalImage = document.getElementById('modal-image');

  if (r.image_path) {
    const { data } = await client.storage.from('receipts').createSignedUrl(r.image_path, 3600);
    if (data) {
      modalImage.src = data.signedUrl;
      imageContainer.classList.remove('hidden');
    }
  } else {
    imageContainer.classList.add('hidden');
  }

  document.getElementById('modal-overlay').classList.remove('hidden');
}

// Close modal
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// Update receipt
document.getElementById('modal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showLoading(true);

  try {
    const { error } = await client.from('receipts').update({
      date: document.getElementById('modal-date').value || null,
      store_name: document.getElementById('modal-store').value || null,
      amount: document.getElementById('modal-amount').value ? parseInt(document.getElementById('modal-amount').value) : null,
      is_qualified: document.querySelector('input[name="modal_qualified"]:checked').value === 'true',
      tax_rate: document.querySelector('input[name="modal_tax_rate"]:checked') ? parseInt(document.querySelector('input[name="modal_tax_rate"]:checked').value) : null,
      category: document.getElementById('modal-category').value || null,
      payment_method: document.getElementById('modal-payment-method').value || null,
      memo: document.getElementById('modal-memo').value || null,
    }).eq('id', currentReceiptId);
    if (error) throw error;

    closeModal();
    await loadReceipts();
  } catch (err) {
    alert('更新に失敗しました: ' + err.message);
  } finally {
    showLoading(false);
  }
});

// Delete receipt
document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm('このレシートを削除しますか？')) return;
  showLoading(true);

  try {
    if (currentImagePath) {
      await client.storage.from('receipts').remove([currentImagePath]);
    }
    const { error } = await client.from('receipts').delete().eq('id', currentReceiptId);
    if (error) throw error;

    closeModal();
    await loadReceipts();
  } catch (err) {
    alert('削除に失敗しました: ' + err.message);
  } finally {
    showLoading(false);
  }
});

// Download image
document.getElementById('download-btn').addEventListener('click', async () => {
  if (!currentImagePath) { alert('画像がありません'); return; }

  // The signed URL is cross-origin (supabase.co), so the `download` attribute
  // on <a> is ignored by the browser — passing { download: true } makes
  // Supabase itself send Content-Disposition: attachment, which works cross-origin.
  const { data } = await client.storage.from('receipts')
    .createSignedUrl(currentImagePath, 60, { download: `receipt_${currentReceiptId}.jpg` });
  if (data) {
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.click();
  }
});

function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

init();
