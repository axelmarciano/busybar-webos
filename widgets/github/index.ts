import { Widget } from '../../src/core/widget';

export default class GithubWidget extends Widget {
  static title = 'GitHub';
  static description = 'Unread GitHub notifications count.';
  static configSchema = {
    githubApiToken: {
      type: 'secret' as const,
      label: 'GitHub API token (scope: notifications)',
      required: true,
    },
  };

  async start(): Promise<void> {
    this.every(5 * 60_000, () => this.refresh());
  }

  private async refresh(): Promise<void> {
    const res = await fetch('https://api.github.com/notifications?per_page=50', {
      headers: {
        Authorization: `Bearer ${this.config.githubApiToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'busybar-webos',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      let hint = '';
      if (res.status === 403 && String(this.config.githubApiToken).startsWith('github_pat_')) {
        hint =
          ' — fine-grained PATs (github_pat_…) cannot access the notifications API;' +
          ' use a classic token (ghp_…) with the "notifications" scope';
      }
      throw new Error(
        `GitHub API → HTTP ${res.status}${body.message ? ` (${body.message})` : ''}${hint}`
      );
    }
    const notifications = (await res.json()) as unknown[];
    const count = notifications.length;
    this.log.info(`${count} GitHub notification(s)`);

    await this.draw(
      [
        {
          id: 'notif',
          type: 'text',
          text: count > 0 ? `GH: ${count} notif` : 'GH: clear',
          font: 'normal',
          align: 'center',
          x: 36,
          y: 8,
          timeout: 0,
        },
      ],
      { led: count > 0 ? '#8957E5FF' : undefined }
    );
  }
}
