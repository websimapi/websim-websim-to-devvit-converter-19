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

// --- Redis Helper Class ---
class GameDB {
    constructor(redis, postId) {
        this.redis = redis;
        this.postId = postId;
        this.prefix = \`game:\${postId}\`;
    }

    async getCollection(name) {
        return await this.redis.hGetAll(\`\${this.prefix}:\${name}\`) || {};
    }

    async save(collection, id, data) {
        // Track collection names in a meta-list
        const metaKey = \`\${this.prefix}:meta:collections\`;
        
        // Optimistic list update (using Set logic would be better but keeping compat)
        const exists = await this.redis.get(metaKey);
        const list = exists ? JSON.parse(exists) : [];
        if (!list.includes(collection)) {
            list.push(collection);
            await this.redis.set(metaKey, JSON.stringify(list));
        }
        
        // Save Record
        await this.redis.hSet(\`\${this.prefix}:\${collection}\`, {
            [id]: JSON.stringify(data)
        });
    }

    async delete(collection, id) {
        await this.redis.hDel(\`\${this.prefix}:\${collection}\`, [id]);
    }

    async dumpAll() {
        const metaKey = \`\${this.prefix}:meta:collections\`;
        const exists = await this.redis.get(metaKey);
        const list = exists ? JSON.parse(exists) : [];
        
        const dump = {};
        for (const col of list) {
            dump[col] = await this.getCollection(col);
        }
        return dump;
    }
}

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
    const db = new GameDB(context.redis, postId);

    // 1. Load Initial State (Server-Side)
    // using useAsync ensures Redis calls happen in the correct context
    const { data: initialData, loading, error } = useAsync(async () => {
        return await db.dumpAll();
    });

    // 2. Realtime Channel for Multiplayer Events
    const channel = useChannel({
        name: \`game_\${postId}\`,
        onMessage: (msg) => {
            // Forward events from other clients to our WebView
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
                    if (!msg || !msg.type) return;

                    try {
                        // 1. Handshake: Send pre-loaded data
                        if (msg.type === 'webViewReady') {
                            context.ui.webView.postMessage('gameview', {
                                type: 'WEBSIM_SOCKET_EVT',
                                payload: { 
                                    type: 'batch_dump', 
                                    data: initialData || {} 
                                }
                            });
                        }
                        
                        // 2. User Context: Fetch Reddit Username/Avatar
                        else if (msg.type === 'get_user_context') {
                            let user = null;
                            try { user = await context.reddit.getCurrentUser(); } catch(e) {}
                            
                            context.ui.webView.postMessage('gameview', {
                                type: 'set_user_context',
                                payload: {
                                    id: user ? user.id : 'anon',
                                    username: user ? user.username : 'Guest',
                                    avatar_url: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                                }
                            });
                        }

                        // 3. Socket/DB Operations (Create, Update, Delete)
                        else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                            const { type, payload } = msg.payload || {};
                            
                            // Database Operations (Persisted to Redis)
                            if (type === 'db_op') {
                                const { cmd, collection, data } = payload;
                                if (cmd === 'create' || cmd === 'update') {
                                    await db.save(collection, data.id, data);
                                } else if (cmd === 'delete') {
                                    await db.delete(collection, data.id);
                                }
                                
                                // Broadcast change to other clients
                                await channel.send({
                                    type: 'db_sync',
                                    collection,
                                    op: payload
                                });
                            } else {
                                // Ephemeral Events (Presence, Chat) - Just Broadcast
                                await channel.send(msg.payload);
                            }
                        }
                        
                        // 4. Console Logging from WebView
                        else if (msg.type === 'console') {
                             // console.log(\`[Web] \${msg.args.join(' ')}\`);
                        }
                    } catch(err) {
                        console.error('[Devvit] Error in onMessage:', err);
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

