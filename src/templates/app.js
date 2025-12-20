export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit } from '@devvit/public-api';

// 1. Define the Registry Key
const DB_REGISTRY_KEY = 'sys:registry';

Devvit.configure({
  redditAPI: true,
  redis: true,
});

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

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    return (
      <vstack height="100%" width="100%">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          onMessage={async (msg, webviewContext) => {
            // CRITICAL: Use the context passed to onMessage, NOT the render context.
            // The render context is stale by the time this event fires, causing "ServerCallRequired".
            const { redis, reddit, ui } = webviewContext;
            const { type, payload } = msg;

            // 1. HYDRATE (Load All Data) - Server Push
            if (type === 'CLIENT_READY' || type === 'DB_LOAD') {
                try {
                    // Fetch Registry
                    const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
                    const dbData = {};
                    
                    // Parallel Fetch
                    await Promise.all(collections.map(async (col) => {
                        const colName = typeof col === 'string' ? col : col.member;
                        const raw = await redis.hGetAll(colName);
                        const parsed = {};
                        // Redis returns strings, parse back to objects
                        for (const [k, v] of Object.entries(raw)) {
                            try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
                        }
                        dbData[colName] = parsed;
                    }));

                    // Identity Injection
                    let user = null;
                    try {
                        const currUser = await reddit.getCurrentUser();
                        user = {
                            id: currUser ? currUser.id : 'anon',
                            username: currUser ? currUser.username : 'Guest',
                            avatar_url: currUser?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                        };
                    } catch(e) {
                         // Fallback identity
                         user = { id: 'anon', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' };
                    }

                    // Push to Client
                    ui.webView.postMessage('gameview', {
                        type: 'DB_HYDRATE',
                        payload: dbData,
                        user
                    });
                } catch(e) {
                    console.error('DB Load Error:', e);
                }
            }

            // 2. SAVE (Hot Swap)
            if (type === 'DB_SAVE' && payload) {
                try {
                    const { collection, key, value } = payload;
                    await redis.hSet(collection, { [key]: JSON.stringify(value) });
                    await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
                } catch(e) {
                    console.error('DB Save Error:', e);
                }
            }
            
            // 3. Logging
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

