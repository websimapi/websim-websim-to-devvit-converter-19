export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useAsync, useState } from '@devvit/public-api';

// ------------------------------------------------------------------------
// Server-Side Logic (Registry Pattern)
// ------------------------------------------------------------------------
const DB_REGISTRY_KEY = 'sys:registry';

Devvit.configure({
  redditAPI: true,
  redis: true,
});

// Helper: Fetch all collections dynamically
async function fetchAllData(redis, reddit) {
    try {
        // 1. Get Registry (List of active collections)
        const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
        const dbData = {};

        // 2. Parallel Fetch
        await Promise.all(collections.map(async (item) => {
            const colName = typeof item === 'string' ? item : item.member;
            const raw = await redis.hGetAll(colName);
            const parsed = {};
            for (const [k, v] of Object.entries(raw)) {
                try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
            }
            dbData[colName] = parsed;
        }));

        // 3. Get User Identity
        let user = { id: 'anon', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' };
        try {
            const currUser = await reddit.getCurrentUser();
            if (currUser) {
                user = {
                    id: currUser.id,
                    username: currUser.username,
                    avatar_url: currUser.snoovatarImage || user.avatar_url
                };
            }
        } catch(e) { console.warn('User fetch failed', e); }

        return { dbData, user };
    } catch(e) {
        console.error('Hydration Error:', e);
        return null;
    }
}

// ------------------------------------------------------------------------
// Menu Actions
// ------------------------------------------------------------------------

Devvit.addMenuItem({
  label: 'Add Game Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    const subreddit = await reddit.getCurrentSubreddit();
    const post = await reddit.submitPost({
      title: '${safeTitle}',
      subredditName: subreddit.name,
      preview: (
        <vstack height="100%" width="100%" alignment="middle center">
          <text size="large">Loading Game...</text>
        </vstack>
      ),
    });
    ui.showToast({ text: 'Created Game Post!' });
    ui.navigateTo(post);
  },
});

// ------------------------------------------------------------------------
// Main Game Post
// ------------------------------------------------------------------------

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    const { redis, reddit, ui } = context;
    
    // Initial Hydration using useAsync (Prevents ServerCallRequired in render)
    const { data: initialData, loading } = useAsync(async () => {
        return await fetchAllData(redis, reddit);
    });

    const [webviewVisible, setWebviewVisible] = useState(false);

    // Once data is loaded, we can signal the webview is ready to be shown/hydrated
    if (!loading && initialData && !webviewVisible) {
        setWebviewVisible(true);
    }

    return (
      <vstack height="100%" width="100%">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          onMessage={async (event, webviewContext) => {
            // CRITICAL: Destructure from the event handler context, NOT the render closure
            // This fixes "Cannot destructure property 'redis' of undefined"
            const { redis, ui } = webviewContext; 
            
            // message is the first arg (event), containing { type, payload }
            const msg = event; 
            const { type, payload } = msg || {};

            if (!type) return;

            // A. Client Requests Hydration (or we push it)
            if (type === 'CLIENT_READY' || type === 'DB_LOAD') {
                if (initialData) {
                    ui.webView.postMessage('gameview', {
                        type: 'DB_HYDRATE',
                        payload: initialData.dbData,
                        user: initialData.user
                    });
                } else {
                    // Fallback re-fetch if useAsync failed or didn't run? 
                    // (Shouldn't happen if logic above is correct)
                }
            }

            // B. Database Save (Hot Swap)
            if (type === 'DB_SAVE' && payload) {
                try {
                    const { collection, key, value } = payload;
                    // 1. Save Data
                    await redis.hSet(collection, { [key]: JSON.stringify(value) });
                    // 2. Update Registry (Async, best effort)
                    await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
                } catch(e) {
                    console.error('DB Save Error:', e);
                }
            }
            
            // C. Logging
            if (type === 'console') {
                console.log('[Web]', ...(msg.args || []));
            }
          }}
        />
      </vstack>
    );
  },
});

export default Devvit;
`;
};

