const $ = (id) => document.getElementById(id);

function updatePlaceholder() {
  $('model').placeholder = ChatSaverSummary.DEFAULT_MODELS[$('provider').value];
}

chrome.storage.local.get(['provider', 'apiKey', 'model', 'backupFolder'], (s) => {
  $('backupFolder').value = s.backupFolder || '';
  $('provider').value = s.provider || 'openai';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  updatePlaceholder();
});

$('provider').addEventListener('change', updatePlaceholder);

$('save').addEventListener('click', () => {
  chrome.storage.local.set({
    provider: $('provider').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    backupFolder: $('backupFolder').value.trim(),
  }, () => {
    $('status').textContent = 'Saved';
    setTimeout(() => { $('status').textContent = ''; }, 2000);
  });
});
