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
        try {
            return await this.redis.hGetAll(\`\${this.prefix}:\${name}\`) || {};
        } catch(e) { console.error('Redis Read Error', e); return {}; }
    }

    async save(collection, id, data) {
        const metaKey = \`\${this.prefix}:meta:collections\`;
        try {
            const exists = await this.redis.get(metaKey);
            const list = exists ? JSON.parse(exists) : [];
            if (!list.includes(collection)) {
                list.push(collection);
                await this.redis.set(metaKey, JSON.stringify(list));
            }
            await this.redis.hSet(\`\${this.prefix}:\${collection}\`, {
                [id]: JSON.stringify(data)
            });
        } catch(e) { console.error('Redis Write Error', e); }
    }

    async delete(collection, id) {
        try {
            await this.redis.hDel(\`\${this.prefix}:\${collection}\`, [id]);
        } catch(e) { console.error('Redis Delete Error', e); }
    }

    async dumpAll() {
        try {
            const metaKey = \`\${this.prefix}:meta:collections\`;
            const exists = await this.redis.get(metaKey);
            const list = exists ? JSON.parse(exists) : [];
            
            const dump = {};
            for (const col of list) {
                dump[col] = await this.getCollection(col);
            }
            return dump;
        } catch(e) {
            console.error('Redis Dump Error', e);
            return {};
        }
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

    // 1. Server-Side Data Load & Identity Injection (Server-Push)
    const { data: initData, loading, error } = useAsync(async () => {
        const [dump, user] = await Promise.all([
            db.dumpAll(),
            context.reddit.getCurrentUser()
        ]);

        const identity = {
            id: user ? user.id : 'anon',
            username: user ? user.username : 'Guest',
            avatar_url: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
            // Generic mappings for game engines
            name: user ? user.username : 'Guest',
            display_name: user ? user.username : 'Guest',
            player_image: user?.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
        };

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
                    if (!msg || !msg.type) return;

                    try {
                        // 1. Handshake: Client is ready, Server Pushes Data + Identity
                        if (msg.type === 'webViewReady' || msg.type === 'get_user_context') {
                            if (initData) {
                                // Send DB Dump
                                if (msg.type === 'webViewReady') {
                                    context.ui.webView.postMessage('gameview', {
                                        type: 'WEBSIM_SOCKET_EVT',
                                        payload: { 
                                            type: 'batch_dump', 
                                            data: initData.database || {} 
                                        }
                                    });
                                }
                                
                                // Send Native Identity (Hot-Swap)
                                context.ui.webView.postMessage('gameview', {
                                    type: 'set_user_context',
                                    payload: initData.currentUser
                                });
                            }
                        }

                        // 2. Writes (Persist & Broadcast)
                        else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                            const { type, payload } = msg.payload || {};
                            
                            if (type === 'db_op') {
                                const { cmd, collection, data } = payload;
                                // Writes are allowed in event handlers
                                if (cmd === 'create' || cmd === 'update') {
                                    await db.save(collection, data.id, data);
                                } else if (cmd === 'delete') {
                                    await db.delete(collection, data.id);
                                }
                                
                                await channel.send({
                                    type: 'db_sync',
                                    collection,
                                    op: payload
                                });
                            } else {
                                await channel.send(msg.payload);
                            }
                        }
                        
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

