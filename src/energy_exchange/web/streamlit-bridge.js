'use strict';
// Streamlit's supported v1 iframe wire protocol; no remote SDK or build step.
(() => {
  if (window.parent === window) return;
  let parentOrigin = window.location.origin;
  try { if (document.referrer) parentOrigin = new URL(document.referrer).origin; } catch {}
  const client = crypto.randomUUID();
  const pending = new Map();
  let ready = false, sequence = 0, previousHeight = 0;
  const send = (type, fields = {}) => window.parent.postMessage(
    {isStreamlitMessage: true, type, ...fields}, parentOrigin);
  const sendRequest = entry => {
    if (entry.sent) return;
    entry.sent = true;
    send('streamlit:setComponentValue', {value: entry.request, dataType: 'json'});
  };
  window.collectiveTransport = (path, payload) => {
    if (!['/api/experiment', '/api/policy'].includes(path)) return Promise.reject(Error('Unsupported request path'));
    if (pending.size) return Promise.reject(Error('Wait for the current experiment to finish'));
    return new Promise((resolve, reject) => {
      const id = `${client}_${++sequence}`;
      const entry = {request: {id, path, payload}, resolve, reject, sent: false};
      entry.timeout = setTimeout(() => {
        pending.delete(id);
        reject(Error('The host timed out. Preview or run the experiment again.'));
      }, 45000);
      pending.set(id, entry);
      if (ready) sendRequest(entry);
    });
  };
  const resize = () => {
    const height = Math.max(700, Math.ceil(document.body.getBoundingClientRect().height));
    if (height !== previousHeight) {
      previousHeight = height;
      send('streamlit:setFrameHeight', {height});
    }
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'streamlit:render') return;
    ready = true;
    const response = event.data.args?.response;
    const entry = response && pending.get(response.id);
    if (entry) {
      clearTimeout(entry.timeout);
      pending.delete(response.id);
      if (response.status >= 200 && response.status < 300) entry.resolve(response.body);
      else {
        const detail = response.body?.detail;
        entry.reject(Error(Array.isArray(detail) ? detail.map(x => x.msg || x.message).join(' · ') : detail || 'The request failed'));
      }
    }
    for (const waiting of pending.values()) sendRequest(waiting);
    resize();
  });
  new ResizeObserver(resize).observe(document.body);
  send('streamlit:componentReady', {apiVersion: 1});
  resize();
})();
