import { defineConfig } from 'wxt';

function summaryHostPermissions(): string[] {
  const hosts = new Set(['http://localhost:3000/*']);
  const configuredUrl = process.env.WXT_SUMMARY_API_URL?.trim();

  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      hosts.add(`${url.protocol}//${url.host}/*`);
    } catch {
      // The extension still builds if the URL is missing during local work.
    }
  }

  return [...hosts];
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  autoIcons: {
    baseIconPath: 'assets/icon.svg',
  },
  manifest: ({ browser }) => ({
    name: 'Comment Catcher for YouTube',
    description:
      'Collect and summarize comments loaded on a YouTube video page.',
    permissions: ['activeTab', 'storage'],
    host_permissions: summaryHostPermissions(),
    action: {
      default_title: 'Open Comment Catcher',
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'comment-catcher@youtubecomments.local',
              data_collection_permissions: {
                required: [
                  'browsingActivity' as const,
                  'websiteContent' as const,
                ],
              },
            },
          },
        }
      : {}),
  }),
});
