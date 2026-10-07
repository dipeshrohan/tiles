import { esc } from '../lib/dom.js';

export default {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const { user } = ctx.state;
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
      </div>`;
  },
  bind(root, ctx) {
    root.querySelector('#profile').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      const email = e.target.email.value.trim();
      ctx.update((s) => (s.user = { name, email }));
      ctx.toast('Profile saved');
    });
    root.querySelector('[data-reset]').addEventListener('click', () => {
      if (confirm('Reset ontology history, design runs and chat to the demo defaults?')) ctx.reset();
    });
  },
};
