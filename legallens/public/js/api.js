import { auth } from "./firebase.js";

async function call(path, opts = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const res = await fetch('/api' + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

export const api = {
  saveProfile: (name, phone) => call('/auth/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone }) }),
  me: () => call('/me'),
  dashboard: () => call('/dashboard'),
  documents: () => call('/documents'),
  upload: file => { const f = new FormData(); f.append('file', file); return call('/documents', { method: 'POST', body: f }); },
  uploadWithProgress: (file, onProgress) => {
    return new Promise(async (resolve, reject) => {
      try {
        const user = auth.currentUser;
        if (!user) return reject(new Error('Not signed in'));
        const token = await user.getIdToken();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/documents');
        xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        if (xhr.upload && onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              onProgress(pct);
            }
          };
        }
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || 'Upload failed (' + xhr.status + ')'));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        const f = new FormData();
        f.append('file', file);
        xhr.send(f);
      } catch (err) { reject(err); }
    });
  },
  document: id => call('/documents/' + id),
  part: (id, part) => call(`/documents/${id}/${part}`),
  chat: (id, message, history, lang) => call(`/documents/${id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history, lang }) }),
  generalChat: (message, history, lang) => call('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history, lang }) }),
  remove: id => call('/documents/' + id, { method: 'DELETE' }),
  deleteAllData: () => call('/user/data', { method: 'DELETE' }),
  exportDoc: id => call('/documents/' + id + '/export'),
  compare: (file1, file2) => { const f = new FormData(); f.append('file1', file1); f.append('file2', file2); return call('/documents/compare', { method: 'POST', body: f }); },
  setReminder: data => call('/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
};
