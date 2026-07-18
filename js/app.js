let currentReceiptId = null;
let currentImagePath = null;
let allReceipts = [];
let addItems = [];
let addBusy = false;

const CATEGORY_OPTIONS = ['会議費', '交通費', '消耗品費', '通信費', '接待交際費', '研修費', '広告宣伝費', 'その他'];

async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  await loadReceipts();

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

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  await client.auth.signOut();
  window.location.href = 'index.html';
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
        <img class="receipt-row-thumb" src="${item.previewUrl}" alt="レシート画像">
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

  if (!addItems.length) {
    toolbar.classList.add('hidden');
    saveBtn.classList.add('hidden');
    return;
  }

  const selectedCount = addItems.filter(it => it.selected).length;

  toolbar.classList.remove('hidden');
  saveBtn.classList.remove('hidden');
  document.getElementById('add-count-label').textContent = `${selectedCount}件選択中`;
  saveBtn.disabled = selectedCount === 0;
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
  }
});

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
      item.ocrError = err.message || String(err);
      // fields stay at their current values — editable and savable regardless
    }
    renderAddRow(item.id);
  }

  addBusy = false;
  document.getElementById('add-ocr-btn').disabled = false;
  document.getElementById('add-save-btn').disabled = false;
  updateAddToolbar();
}
document.getElementById('add-ocr-btn').addEventListener('click', runOcrForPendingItems);

// Save only the checked rows: one Storage upload per file (no bulk upload API),
// one array insert for the DB rows. Unselected rows stay in the list untouched.
async function saveAllReceipts() {
  const selectedItems = addItems.filter(it => it.selected);
  if (addBusy || !selectedItems.length) return;

  const missingDateIndexes = selectedItems
    .map((it, i) => (it.fields.date ? null : i + 1))
    .filter(i => i !== null);
  if (missingDateIndexes.length) {
    alert(`日付が未入力のレシートがあります（選択した${missingDateIndexes.join('、')}件目）。日付を入力してから保存してください。`);
    return;
  }

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

// Export CSV
document.getElementById('export-csv-btn').addEventListener('click', () => {
  if (!allReceipts.length) { alert('エクスポートするレシートがありません'); return; }

  const headers = ['日付', '店名・取引先', '金額', '適格請求書', '消費税率', '勘定科目', '取引手段', '摘要', '画像リンク'];
  const baseUrl = `${window.location.origin}${window.location.pathname}`;

  const rows = allReceipts.map(r => [
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

  const { data } = await client.storage.from('receipts').createSignedUrl(currentImagePath, 60);
  if (data) {
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = `receipt_${currentReceiptId}.jpg`;
    a.click();
  }
});

function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

init();
