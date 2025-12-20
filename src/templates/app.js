export const getServerTs = () => `
import { Devvit, RedditAPIClient, RedisClient } from '@devvit/public-api';

// Registry key to track all active collections
const DB_REGISTRY_KEY = 'sys:registry';

export type WebViewMessage = {
  type: string;
  payload?: any;
};

// --- Helper: Identity Resolution ---
async function getUser(reddit: RedditAPIClient) {
  try {
    const currUser = await reddit.getCurrentUser();
    return {
      id: currUser?.id || 'anon',
      username: currUser?.username || 'Guest',
      avatar_url: currUser?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
    };
  } catch (e) {
    return { 
      id: 'anon', 
      username: 'Guest', 
      avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' 
    };
  }
}

// --- Helper: Database Hydration ---
async function fetchAllData(redis: RedisClient) {
  const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
  const dbData: Record<string, any> = {};

  await Promise.all(collections.map(async (entry) => {
    // zRange can return objects { member, score } or strings depending on version/args, handle both
    const colName = typeof entry === 'string' ? entry : entry.member;
    const raw = await redis.hGetAll(colName);
    const parsed: Record<string, any> = {};
    
    for (const [k, v] of Object.entries(raw)) {
      try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
    }
    dbData[colName] = parsed;
  }));
  
  return dbData;
}

// --- Main Server Handler ---
export async function handleWebviewMessage(msg: WebViewMessage, context: Devvit.Context) {
  const { type, payload } = msg;
  const { redis, reddit } = context;

  // 1. Initial Load / Handshake
  if (type === 'CLIENT_READY' || type === 'DB_LOAD') {
    const [dbData, user] = await Promise.all([
      fetchAllData(redis),
      getUser(reddit)
    ]);

    return {
      type: 'DB_HYDRATE',
      payload: dbData,
      user
    };
  }

  // 2. Save Data
  if (type === 'DB_SAVE' && payload) {
    const { collection, key, value } = payload;
    if (!collection || !key) return null;

    // Save actual data
    await redis.hSet(collection, { [key]: JSON.stringify(value) });
    // Update registry so we know this collection exists
    await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
    
    return { type: 'DB_SAVED_ACK', payload: { collection, key } };
  }

  // 3. Logging
  if (type === 'console') {
    console.log('[Web]', ...(payload?.args || []));
  }

  return null;
}
`;

export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit } from '@devvit/public-api';
import { handleWebviewMessage } from './server';

// Configure Capabilities
Devvit.configure({
  redditAPI: true,
  redis: true,
  http: true, // Useful for some integrations
});

// Menu Item: Create Post
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

// Custom Post: The Game Wrapper
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
          onMessage={async (msg) => {
             // Dispatch to Server Handler
             try {
                const response = await handleWebviewMessage(msg as any, context);
                if (response) {
                    context.ui.webView.postMessage('gameview', response);
                }
             } catch (e) {
                console.error('Server Error:', e);
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

