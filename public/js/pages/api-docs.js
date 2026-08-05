/* API docs page: Swagger UI isolated in an iframe */

export function render({ root }) {
  root.innerHTML = `
    <h1>API</h1>
    <p class="detail-desc">Everything the dashboard does goes through this API — automate it.
      Spec: <a href="/openapi.yaml" target="_blank" rel="noreferrer" style="color: var(--accent);">openapi.yaml</a></p>
    <iframe class="api-frame" src="/api-docs.html" title="API documentation"></iframe>
  `;
}
