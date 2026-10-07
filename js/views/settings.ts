import { esc, field, need, onAll, onSubmit } from '../lib/dom.ts';
import { createApiClient, normalizeBaseUrl } from '../lib/api.ts';
import type { View } from './types.ts';

const view: View = {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const { user } = ctx.state;
    const ds = ctx.dataSource;
    return `
      <div class="page-head"><div><div class="eyebrow">Workspace</div><h1>Settings</h1></div></div>
      <div class="grid g2">
        <form class="card stack" id="profile" style="gap:12px">
          <h2>Profile</h2>
          <p class="small soft">Your name and email are recorded as the author of ontology commits and design runs.</p>
          <label class="field">Name<input type="text" name="name" value="${esc(user.name)}" required /></label>
          <label class="field">Email<input type="text" name="email" value="${esc(user.email)}" required /></label>
          <div><button class="btn primary" type="submit">Save</button></div>
        </form>
        <div class="card stack" style="gap:12px">
          <h2>Demo data</h2>
          <p class="small soft">Plant data (cutter batches, welder power, die-cast shots) is synthetic and regenerated from fixed seeds. Your ontology commits, design runs and chat are saved in this browser.</p>
          <div><button class="btn danger" data-reset>Reset workspace</button></div>
        </div>
        <form class="card stack" id="datasource" style="gap:12px">
          <h2>Data source</h2>
          <p class="small soft">Keep data in this browser, or share it through the Tiles API (<code>docker compose up</code> starts one on port 8000). Pages move to the API one at a time.</p>
          <label class="row" style="gap:8px"><input type="radio" name="mode" value="local" ${ds.mode === 'local' ? 'checked' : ''} /> This browser only</label>
          <label class="row" style="gap:8px"><input type="radio" name="mode" value="api" ${ds.mode === 'api' ? 'checked' : ''} /> Tiles API</label>
          <label class="field">API address<input type="url" name="apiUrl" value="${esc(ds.apiUrl)}" required /></label>
          <div class="row" style="gap:8px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-test-api>Test connection</button></div>
          <p class="small soft" data-api-status aria-live="polite"></p>
        </form>
      </div>`;
  },
  bind(root, ctx) {
    onSubmit(root, '#profile', (form) => {
      const name = field(form, 'name').trim();
      const email = field(form, 'email').trim();
      ctx.update((s) => (s.user = { name, email }));
      ctx.toast('Profile saved');
    });
    onSubmit(root, '#datasource', (form) => {
      const mode = (form.elements.namedItem('mode') as RadioNodeList).value === 'api' ? 'api' : 'local';
      ctx.setDataSource({ mode, apiUrl: normalizeBaseUrl(field(form, 'apiUrl')) });
      ctx.toast(mode === 'api' ? 'Using the Tiles API' : 'Using this browser only');
    });
    onAll(root, '[data-test-api]', 'click', async () => {
      const status = need(root, '[data-api-status]');
      const url = field(need<HTMLFormElement>(root, '#datasource'), 'apiUrl');
      status.textContent = 'Checking…';
      try {
        const h = await createApiClient({ baseUrl: url, onError: (e) => ctx.toast(e.message) }).health();
        status.textContent = `Connected: Tiles API ${h.version} (${h.env})`;
      } catch {
        status.textContent = 'Not reachable';
      }
    });
    onAll(root, '[data-reset]', 'click', () => {
      if (confirm('Reset ontology history, design runs and chat to the demo defaults?')) ctx.reset();
    });
  },
};

export default view;
