export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useChannel, useAsync, useState } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
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
    const postId = context.postId || 'global';
    
    // --- Redis Logic (Simplified) ---
    // We map WebSim "collections" to Redis Hashes.
    // keys: "game:{postId}:{collectionName}"
    // meta: "game:{postId}:collections" (Set of known collection names)

    // 1. Initial Data Load (Server Push)
    // We fetch EVERYTHING needed for the game start here to avoid "ServerCallRequired" later.
    const { data: initData, loading, error } = useAsync(async () => {
        const { redis, reddit } = context;
        
        // A. Identity
        const user = await reddit.getCurrentUser();
        const identity = {
            id: user ? user.id : 'anon',
            username: user ? user.username : 'Guest',
            avatar_url: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
        };

        // B. Database Dump
        // Fetch known collections
        const metaKey = \`game:\${postId}:collections\`;
        const collectionsStr = await redis.get(metaKey);
        const collectionNames = collectionsStr ? JSON.parse(collectionsStr) : [];
        
        const dump = {};
        for (const col of collectionNames) {
            // HGETALL returns object { key: value }
            dump[col] = await redis.hGetAll(\`game:\${postId}:\${col}\`) || {};
        }

        return {
            database: dump,
            currentUser: identity
        };
    });

    // 2. Realtime Channel
    const channel = useChannel({
        name: \`game_\${postId}\`,
        onMessage: (msg) => {
            context.ui.webView.postMessage('gameview', {
                type: 'WEBSIM_SOCKET_EVT',
                payload: msg
            });
        }
    });
    channel.subscribe();

    return (
        <vstack height="100%" width="100%" alignment="center middle">
            <webview
                id="gameview"
                url="${webviewPath}"
                width="100%"
                height="100%"
                onMessage={async (msg) => {
                    // console.log('[Devvit] Received:', JSON.stringify(msg));
                    if (!msg || !msg.type) return;

                    const { redis } = context;

                    // A. Handshake: Client Ready -> Send Init Data
                    if (msg.type === 'webViewReady') {
                        if (initData) {
                            console.log('[Server] Handshake received, sending init data.');
                            context.ui.webView.postMessage('gameview', {
                                type: 'WEBSIM_SOCKET_EVT',
                                payload: { 
                                    type: 'batch_dump', 
                                    data: initData.database,
                                    user: initData.currentUser
                                }
                            });
                        }
                    }

                    // B. Database Writes
                    else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                        const wrapper = msg.payload || {};
                        const { type, payload } = wrapper;

                        // DB Operations
                        if (type === 'db_op') {
                            const { cmd, collection, data } = payload;
                            const colKey = \`game:\${postId}:\${collection}\`;
                            
                            // Ensure collection is tracked
                            const metaKey = \`game:\${postId}:collections\`;
                            const collectionsStr = await redis.get(metaKey);
                            const list = collectionsStr ? JSON.parse(collectionsStr) : [];
                            if (!list.includes(collection)) {
                                list.push(collection);
                                await redis.set(metaKey, JSON.stringify(list));
                            }

                            if (cmd === 'create' || cmd === 'update') {
                                // HSET key field value
                                await redis.hSet(colKey, { [data.id]: JSON.stringify(data) });
                            } else if (cmd === 'delete') {
                                await redis.hDel(colKey, [data.id]);
                            }

                            // Broadcast sync to other clients
                            await channel.send({
                                type: 'db_sync',
                                collection,
                                op: payload
                            });
                        } 
                        // Other broadcast events (presence etc)
                        else {
                            await channel.send(wrapper); // Send original payload wrapper
                        }
                    }
                    
                    // C. Logging
                    else if (msg.type === 'console') {
                         // Optional: Uncomment to see webview logs in terminal
                         // console.log(\`[Web] \${msg.args.join(' ')}\`);
                    }
                }}
            />
        </vstack>
    );
  }
});

export default Devvit;
`;
};

