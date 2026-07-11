let currentReceiptId = null;
let currentImagePath = null;
let allReceipts = [];
let compressedImageBlob = null;

async function init() {
  const { data: { session } } = await client.auth.getSession();
  if (!session) { window.location.href = 'index.html'; return; }

  document.getElementById('receipt-date').value = today();
  await loadReceipts();
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

// Image preview + auto OCR
document.getElementById('image-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  compressedImageBlob = await compressImage(file);

  const previewUrl = URL.createObjectURL(compressedImageBlob);
  document.getElementById('image-preview').src = previewUrl;
  document.getElementById('image-preview').classList.remove('hidden');
  document.getElementById('upload-placeholder').classList.add('hidden');

  showLoading(true);
  try {
    const base64 = await blobToBase64(compressedImageBlob);
    const { data, error } = await client.functions.invoke('ocr-receipt', {
      body: { image_base64: base64, media_type: 'image/jpeg' },
    });
    if (error) throw error;

    if (data.date) document.getElementById('receipt-date').value = data.date;
    if (data.store_name) document.getElementById('store-name').value = data.store_name;
    if (data.amount != null) document.getElementById('amount').value = data.amount;
    document.querySelectorAll('input[name="is_qualified"]').forEach(radio => {
      radio.checked = radio.value === String(data.is_qualified);
    });
    if (data.tax_rate != null) {
      document.querySelectorAll('input[name="tax_rate"]').forEach(radio => {
        radio.checked = radio.value === String(data.tax_rate);
      });
    }
  } catch (err) {
    alert('自動読み取りに失敗しました。手入力してください: ' + err.message);
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

// Save receipt
document.getElementById('receipt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showLoading(true);

  try {
    const { data: { user } } = await client.auth.getUser();

    let imagePath = null;
    if (compressedImageBlob) {
      imagePath = `${user.id}/${Date.now()}.jpg`;
      const { error } = await client.storage.from('receipts').upload(imagePath, compressedImageBlob, { contentType: 'image/jpeg' });
      if (error) throw error;
    }

    const { error } = await client.from('receipts').insert({
      user_id: user.id,
      date: document.getElementById('receipt-date').value || null,
      store_name: document.getElementById('store-name').value || null,
      amount: document.getElementById('amount').value ? parseInt(document.getElementById('amount').value) : null,
      is_qualified: document.querySelector('input[name="is_qualified"]:checked').value === 'true',
      tax_rate: parseInt(document.querySelector('input[name="tax_rate"]:checked').value),
      category: document.getElementById('category').value || null,
      memo: document.getElementById('memo').value || null,
      image_path: imagePath,
    });
    if (error) throw error;

    document.getElementById('receipt-form').reset();
    document.getElementById('image-preview').classList.add('hidden');
    document.getElementById('upload-placeholder').classList.remove('hidden');
    document.getElementById('receipt-date').value = today();
    compressedImageBlob = null;

    document.querySelector('.tab[data-tab="list"]').click();

  } catch (err) {
    alert('保存に失敗しました: ' + err.message);
  } finally {
    showLoading(false);
  }
});

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
