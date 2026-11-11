let currentReceiptId = null;
let currentImagePath = null;
let allReceipts = [];
let addItems = [];
let addBusy = false;

// Sticky headers stack (header -> tabs -> toolbar) each need to know the
// exact rendered height of the ones above them. Measuring at runtime avoids
// hardcoding pixel guesses that drift whenever fonts/padding change.
function updateStickyOffsets() {
  const header = document.querySelector('header');
  const tabs = document.querySelector('.tabs');
  if (header) document.documentElement.style.setProperty('--header-height', `${header.offsetHeight}px`);
  if (tabs) document.documentElement.style.setProperty('--tabs-height', `${tabs.offsetHeight}px`);
}
updateStickyOffsets();
window.addEventListener('resize', updateStickyOffsets);

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
  if (!session) { window.location.href = 'login.html'; return; }

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
  window.location.href = 'login.html';
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
    window.location.href = 'login.html';
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

// OCR status → the stamp pressed on the receipt photo + the short label on its card
const OCR_STATUS_VIEW = {
  pending: { stamp: ['未', '読取'], label: '未読取' },
  running: { stamp: ['読取', '中'], label: '読み取り中…' },
  done: { stamp: ['読取', '済'], label: '読み取り済み' },
  error: { stamp: ['読取', '失敗'], label: '読み取り失敗' },
};

function stampHtml(item) {
  const view = OCR_STATUS_VIEW[item.ocrStatus] || OCR_STATUS_VIEW.pending;
  return `<div class="desk-stamp desk-stamp-${item.ocrStatus}" style="transform: rotate(${item.tilt.stamp}deg)" aria-hidden="true"><span>${view.stamp[0]}</span><span>${view.stamp[1]}</span></div>`;
}

// Random (not alternating-by-rule) tilt so the receipts look casually spread on the desk
function randomTilt() {
  const between = (min, max) => Math.round((min + Math.random() * (max - min)) * 10) / 10;
  const sign = Math.random() < 0.5 ? -1 : 1;
  return { photo: sign * between(1.5, 5), card: between(-1.5, 1.5), stamp: between(-16, 14) };
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
        flipped: addItems.length % 2 === 1,
        tilt: randomTilt(),
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

// The add buttons are <label for="image-input"> (so tapping opens the picker
// natively on iOS too); let keyboard users trigger them like real buttons.
document.querySelectorAll('label[for="image-input"]').forEach(label => {
  label.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    document.getElementById('image-input').click();
  });
});

const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const CLIP_SVG = '<svg class="desk-clip-card" width="16" height="46" viewBox="0 0 16 46" fill="none" aria-hidden="true"><path d="M5 30V8a3.5 3.5 0 0 1 7 0v26a5.5 5.5 0 0 1-11 0V12" stroke="#8e979f" stroke-width="2" stroke-linecap="round"/></svg>';

// Chips summarising what OCR read for the collapsed detail fields — only after a
// successful read, so untouched defaults (適格 / 10%) aren't presented as facts.
function ocrChipsHtml(item) {
  if (item.ocrStatus !== 'done') return '';
  const chips = [item.fields.is_qualified ? '適格' : '非適格'];
  if (item.fields.tax_rate) chips.push(`${item.fields.tax_rate}%`);
  if (item.fields.payment_method) chips.push(item.fields.payment_method);
  return chips.map(c => `<span class="desk-chip">${escapeHtmlAttr(c)}</span>`).join('');
}

function renderAddRowHtml(item) {
  const view = OCR_STATUS_VIEW[item.ocrStatus] || OCR_STATUS_VIEW.pending;
  const fid = (name) => `${item.id}-${name}`;
  return `
    <div class="receipt-row${item.flipped ? ' is-flipped' : ''}${item.selected ? ' is-selected' : ''}" data-add-id="${item.id}">
      <div class="desk-photo" style="transform: rotate(${item.tilt.photo}deg)">
        <div class="desk-photo-paper">
          <img src="${item.previewUrl}" alt="レシート画像（タップで拡大）" data-action="preview">
        </div>
        ${stampHtml(item)}
      </div>
      <div class="desk-card" style="transform: rotate(${item.tilt.card}deg)">
        ${CLIP_SVG}
        <div class="desk-card-top">
          <label class="desk-chk"><input type="checkbox" data-action="select" ${item.selected ? 'checked' : ''}>選択</label>
          <span class="desk-status desk-status-${item.ocrStatus}">${view.label}</span>
          <button type="button" class="desk-x-btn" data-action="remove" aria-label="このレシートを除外">除外
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="desk-f desk-f-date">
          <label for="${fid('date')}">日付</label>
          <input type="date" id="${fid('date')}" data-field="date" value="${item.fields.date || ''}">
        </div>
        <div class="desk-f desk-f-store_name">
          <label for="${fid('store')}">店名</label>
          <input type="text" id="${fid('store')}" data-field="store_name" value="${escapeHtmlAttr(item.fields.store_name)}" placeholder="店名・取引先">
        </div>
        <div class="desk-f desk-f-amount">
          <label for="${fid('amount')}">金額</label>
          <div class="desk-f-amt"><span aria-hidden="true">¥</span><input type="number" min="0" inputmode="numeric" id="${fid('amount')}" data-field="amount" value="${item.fields.amount ?? ''}" placeholder="0"></div>
        </div>
        <div class="desk-f desk-f-category">
          <label for="${fid('category')}">勘定科目</label>
          <div class="desk-f-sel"><select id="${fid('category')}" data-field="category">${buildSelectOptions(CATEGORY_OPTIONS, item.fields.category)}</select>${CHEVRON_SVG}</div>
        </div>
        <div class="desk-more-row">
          <button type="button" class="desk-more" data-action="toggle-detail" aria-expanded="false"><span>詳細</span>${CHEVRON_SVG}</button>
          ${ocrChipsHtml(item)}
        </div>
        <div class="desk-detail hidden">
          <div class="desk-radio-row">
            <span>インボイス</span>
            <div class="radio-group">
              <label class="radio-label"><input type="radio" name="qualified-${item.id}" data-field="is_qualified" value="true" ${item.fields.is_qualified ? 'checked' : ''}> 適格</label>
              <label class="radio-label"><input type="radio" name="qualified-${item.id}" data-field="is_qualified" value="false" ${!item.fields.is_qualified ? 'checked' : ''}> 非適格</label>
            </div>
          </div>
          <div class="desk-radio-row">
            <span>税率</span>
            <div class="radio-group">
              <label class="radio-label"><input type="radio" name="tax-${item.id}" data-field="tax_rate" value="10" ${item.fields.tax_rate === 10 ? 'checked' : ''}> 10%</label>
              <label class="radio-label"><input type="radio" name="tax-${item.id}" data-field="tax_rate" value="8" ${item.fields.tax_rate === 8 ? 'checked' : ''}> 8%軽減</label>
            </div>
          </div>
          <div class="desk-f desk-f-payment_method">
            <label for="${fid('payment')}">取引手段</label>
            <input type="text" id="${fid('payment')}" data-field="payment_method" value="${escapeHtmlAttr(item.fields.payment_method)}" placeholder="現金、事業用カードなど">
          </div>
          <div class="desk-f desk-f-memo">
            <label for="${fid('memo')}">摘要</label>
            <input type="text" id="${fid('memo')}" data-field="memo" value="${escapeHtmlAttr(item.fields.memo)}" placeholder="任意">
          </div>
          ${item.ocrStatus === 'error' ? `<p class="error-msg">自動読み取りに失敗：${escapeHtmlAttr(item.ocrError || '')}</p>` : ''}
        </div>
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
  const view = OCR_STATUS_VIEW[item.ocrStatus] || OCR_STATUS_VIEW.pending;
  el.querySelector('.desk-stamp').outerHTML = stampHtml(item);
  const statusEl = el.querySelector('.desk-status');
  statusEl.className = `desk-status desk-status-${item.ocrStatus}`;
  statusEl.textContent = view.label;
}

function updateAddToolbar() {
  const toolbar = document.getElementById('add-toolbar');
  const saveBtn = document.getElementById('add-save-btn');
  const bulkRow = document.getElementById('bulk-apply-row');

  // Empty desk shows the big "spread your receipts" frame; once anything is on the
  // desk it shrinks to the slim add strip above the list.
  document.getElementById('add-empty').classList.toggle('hidden', addItems.length > 0);
  document.getElementById('add-slip').classList.toggle('hidden', addItems.length === 0);

  if (!addItems.length) {
    toolbar.classList.add('hidden');
    saveBtn.classList.add('hidden');
    bulkRow.classList.add('hidden');
    return;
  }

  const selectedCount = addItems.filter(it => it.selected).length;

  toolbar.classList.remove('hidden');
  saveBtn.classList.remove('hidden');
  if (!addBusy) {
    document.getElementById('add-count-label').innerHTML = `<b>${selectedCount}</b>件選択中`;
  }
  document.getElementById('bulk-count').textContent = selectedCount;
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
  // Buttons contain an icon/text span, so look up the nearest element that carries the action
  const actionEl = e.target.closest('[data-action]');
  const action = actionEl?.dataset.action;

  if (action === 'remove') {
    removeAddItem(id);
  } else if (action === 'toggle-detail') {
    const detail = row.querySelector('.desk-detail');
    const willShow = detail.classList.contains('hidden');
    detail.classList.toggle('hidden');
    actionEl.classList.toggle('is-open', willShow);
    actionEl.setAttribute('aria-expanded', String(willShow));
    actionEl.querySelector('span').textContent = willShow ? '閉じる' : '詳細';
  } else if (action === 'select') {
    const item = addItems.find(it => it.id === id);
    if (item) item.selected = actionEl.checked;
    row.classList.toggle('is-selected', actionEl.checked);
    updateAddToolbar();
  } else if (action === 'preview') {
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
// Blank here means "clear this field on every selected row", so label it as such
document.getElementById('bulk-apply-value-select').innerHTML =
  '<option value="">（空欄にする）</option>' + buildSelectOptions(CATEGORY_OPTIONS, '').replace('<option value="">未選択</option>', '');

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
  // Outline the fields that will be overwritten (CSS keys off this attribute)
  document.getElementById('add-list').dataset.bulkField = field;
  document.getElementById('bulk-value-wrap').classList.toggle('hidden', !field);
  document.getElementById('bulk-value-label').htmlFor = field === 'category' ? 'bulk-apply-value-select' : 'bulk-apply-value-text';

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

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function ledgerRowHtml(r) {
  let day = '—';
  let weekday = '';
  if (r.date) {
    const [y, m, d] = r.date.split('-').map(Number);
    day = String(d).padStart(2, '0');
    weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  }
  const store = r.store_name
    ? `<span class="desk-lg-store">${escapeHtmlAttr(r.store_name)}</span>`
    : '<span class="desk-lg-store is-none">店名なし</span>';
  const category = r.category
    ? `<span>${escapeHtmlAttr(r.category)}</span>`
    : '<span class="desk-lg-warn">勘定科目なし</span>';
  const qualified = r.is_qualified
    ? '<span class="desk-lg-q">適格</span>'
    : '<span class="desk-lg-q is-no">非適格</span>';
  const amount = r.amount != null ? '¥' + r.amount.toLocaleString() : '—';
  return `
    <li><button type="button" class="desk-lg-row" data-id="${escapeHtmlAttr(r.id)}">
      <span class="desk-lg-day"><span class="desk-lg-d">${day}</span><span class="desk-lg-w">${weekday}</span></span>
      <span class="desk-lg-main">${store}<span class="desk-lg-meta">${category}${qualified}</span></span>
      <span class="desk-lg-amt">${amount}</span>
    </button></li>`;
}

// 帳簿は月ごとに区切る。並びは日付の新しい順で、日付なしは最後（loadReceiptsの並び順のまま）
function renderReceipts(receipts) {
  const list = document.getElementById('receipt-list');
  const empty = document.getElementById('empty-state');

  list.classList.toggle('hidden', !receipts.length);
  empty.classList.toggle('hidden', !!receipts.length);
  if (!receipts.length) {
    list.innerHTML = '';
    return;
  }

  const groups = [];
  receipts.forEach(r => {
    const key = r.date ? r.date.slice(0, 7) : '';
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, items: [] };
      groups.push(group);
    }
    group.items.push(r);
  });

  list.innerHTML = groups.map(g => {
    const heading = g.key
      ? `<span class="desk-lg-m">${Number(g.key.slice(5, 7))}月</span><span class="desk-lg-y">${g.key.slice(0, 4)}</span>`
      : '<span class="desk-lg-m">日付なし</span>';
    return `
      <h2 class="desk-lg-month">${heading}<span class="desk-lg-n">${g.items.length}件</span></h2>
      <ul>${g.items.map(ledgerRowHtml).join('')}</ul>`;
  }).join('');
}

document.getElementById('receipt-list').addEventListener('click', (e) => {
  const row = e.target.closest('.desk-lg-row');
  if (row) openReceipt(row.dataset.id);
});

document.getElementById('search-input').addEventListener('input', loadReceipts);

// CSV date range picker
document.getElementById('csv-range-select').addEventListener('change', (e) => {
  const isCustom = e.target.value === 'custom';
  document.getElementById('csv-range-custom').classList.toggle('hidden', !isCustom);
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
  setCsvMenuOpen(document.getElementById('csv-export-menu').classList.contains('hidden'));
});
function setCsvMenuOpen(open) {
  document.getElementById('csv-export-menu').classList.toggle('hidden', !open);
  document.getElementById('csv-export-toggle').setAttribute('aria-expanded', String(open));
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('csv-export-menu');
  if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'csv-export-toggle') {
    setCsvMenuOpen(false);
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
  setCsvMenuOpen(false);
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
  setCsvMenuOpen(false);
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

function setRadioValue(name, value) {
  document.querySelectorAll(`input[name="${name}"]`).forEach(input => {
    input.checked = input.value === value;
  });
}

function getRadioValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
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
  setRadioValue('modal_qualified', String(r.is_qualified));
  setRadioValue('modal_tax_rate', String(r.tax_rate));

  // 写真は最初は出さない（読み込みで入力欄がずれないように）。開いた時点で裏で読み込んでおき、「写真」ボタンで重ねて出す
  setModalPhotoOpen(false);
  setModalPhotoState('loading');
  document.getElementById('modal-image').removeAttribute('src');
  document.getElementById('modal-photo-toggle').classList.toggle('hidden', !r.image_path);

  document.getElementById('modal-overlay').classList.remove('hidden');

  if (r.image_path) {
    const { data } = await client.storage.from('receipts').createSignedUrl(r.image_path, 3600);
    if (currentReceiptId !== id) return; // 読み込み中に別のレシートを開いた
    if (data) document.getElementById('modal-image').src = data.signedUrl;
    else setModalPhotoState('error');
  }
}

function setModalPhotoState(state) {
  document.getElementById('modal-image-btn').classList.toggle('is-loading', state !== 'ready');
  document.getElementById('modal-image-status').textContent =
    state === 'error' ? '写真を読み込めませんでした' : '読み込み中…';
}

function setModalPhotoOpen(open) {
  document.getElementById('modal-image-container').classList.toggle('hidden', !open);
  document.getElementById('modal-photo-toggle').setAttribute('aria-expanded', String(open));
}

document.getElementById('modal-image').addEventListener('load', (e) => {
  if (e.target.getAttribute('src')) setModalPhotoState('ready');
});
document.getElementById('modal-image').addEventListener('error', (e) => {
  if (e.target.getAttribute('src')) setModalPhotoState('error');
});
document.getElementById('modal-photo-toggle').addEventListener('click', () => {
  const open = document.getElementById('modal-image-container').classList.contains('hidden');
  setModalPhotoOpen(open);
});
document.getElementById('modal-photo-close').addEventListener('click', () => setModalPhotoOpen(false));
// 写真の外側（薄暗い部分）を押したら写真だけしまう
document.getElementById('modal-image-container').addEventListener('click', (e) => {
  if (e.target.id === 'modal-image-container') setModalPhotoOpen(false);
});

// Close modal
document.getElementById('modal-close').addEventListener('click', closeModal);
// 写真とカードの外側（暗くした机の部分）を押したら閉じる
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (['modal-overlay', 'modal'].includes(e.target.id)) closeModal();
});
document.getElementById('modal-image-btn').addEventListener('click', (e) => {
  if (e.currentTarget.classList.contains('is-loading')) return;
  const src = document.getElementById('modal-image').getAttribute('src');
  if (src) openImageLightbox(src);
});

function closeModal() {
  setModalPhotoOpen(false);
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
      is_qualified: getRadioValue('modal_qualified') === 'true',
      tax_rate: getRadioValue('modal_tax_rate') ? parseInt(getRadioValue('modal_tax_rate')) : null,
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
