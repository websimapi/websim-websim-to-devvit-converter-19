export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useAsync } from '@devvit/public-api';

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
    // STATE: Tracks what the Client wants the Server to do
    // 'id' ensures useAsync re-runs when task changes
    const [task, setTask] = useState({ type: 'IDLE', payload: null, id: 0 });

    // ---------------------------------------------------------
    // GENERIC DATABASE HANDLER (Running on Server)
    // ---------------------------------------------------------
    useAsync(async () => {
      if (task.type === 'IDLE') return;

      try {
        // A. GENERIC SAVE: "Hot Swap" Support
        // The client sends { collection: 'enemies', key: 'orc_1', value: {...} }
        if (task.type === 'DB_SAVE') {
          const { collection, key, value } = task.payload;
          
          // 1. Save the actual data
          await context.redis.hSet(collection, { [key]: JSON.stringify(value) });
          
          // 2. Register this collection so we know to load it next time
          await context.redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
        }

        // B. GENERIC LOAD: The "Magic" Loader
        // Fetches ALL collections registered in the system automatically
        if (task.type === 'DB_LOAD') {
          // 1. Get list of all collections we ever saved
          const collections = await context.redis.zRange(DB_REGISTRY_KEY, 0, -1);
          
          const fullDatabase = {};
          
          // 2. Load them all in parallel
          await Promise.all(collections.map(async (col) => {
            // zRange return type depends on version, normalizing to string
            const colName = typeof col === 'string' ? col : col.member;
            
            const data = await context.redis.hGetAll(colName);
            // Parse JSON strings back to objects
            const parsedData = {};
            for (const [k, v] of Object.entries(data)) {
                 try { parsedData[k] = JSON.parse(v); } catch(e) { parsedData[k] = v; }
            }
            fullDatabase[colName] = parsedData;
          }));

          // 3. Identity Injection (Critical for WebSim apps)
          let identity = null;
          try {
             const user = await context.reddit.getCurrentUser();
             identity = {
                id: user ? user.id : 'anon',
                username: user ? user.username : 'Guest',
                avatar_url: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
             };
          } catch(e) {
             console.error('Identity fetch error', e);
          }

          // 4. Send the entire DB state to the game
          context.ui.webView.postMessage('gameview', {
            type: 'DB_HYDRATE',
            payload: fullDatabase,
            user: identity
          });
        }

      } catch (err) {
        console.error("DB Error:", err);
      }
    }, { depends: [task.id] }); // Re-run whenever task ID changes

    // ---------------------------------------------------------
    // UI & MESSAGE ROUTING
    // ---------------------------------------------------------
    return (
      <vstack height="100%" width="100%">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          onMessage={(msg) => {
            // "Internal" handshake to ensure connection is alive
            if (msg.type === 'CLIENT_READY') {
              // console.log("Client connected. Loading DB...");
              setTask({ type: 'DB_LOAD', payload: null, id: Date.now() });
              return;
            }

            // Route database requests to the async handler
            if (msg.type === 'DB_SAVE' || msg.type === 'DB_LOAD') {
              setTask({ type: msg.type, payload: msg.payload, id: Date.now() });
            }
            
            // Log forwarding (optional)
            if (msg.type === 'console') {
                // console.log('[Web]', ...(msg.args || []));
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

