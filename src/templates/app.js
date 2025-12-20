export const getMainTsx = (title, webviewPath = 'index.html') => {
  const safeTitle = title.replace(/'/g, "\\'");
  return `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

Devvit.addCustomPostType({
  name: 'WebSim Game',
  height: 'tall',
  render: (context) => {
    // 1. STATE: Triggers for Server Actions
    const [key, setKey] = useState(0); 
    const [syncReq, setSyncReq] = useState({ id: 0, type: '', payload: {} });
    const [lastProcessed, setLastProcessed] = useState(0);

    // 2. SERVER: useAsync (Runs on Server)
    const { data: serverRes } = useAsync(async () => {
      if (!syncReq.id || syncReq.id === 0) return null;
      
      const { type, payload } = syncReq;
      console.log(\`[Server] Processing Request: \${type}\`);

      try {
        // --- Handshake / Load ---
        if (type === 'batch_load') {
          const collections = payload.collections || [];
          const results = {};
          
          for (const col of collections) {
            try {
               const data = await context.redis.hGetAll(\`websim:data:\${col}\`);
               results[col] = data || {};
            } catch(e) { results[col] = {}; }
          }
          console.log(\`[Server] Loaded \${collections.length} collections.\`);
          return { type: 'batch_dump', data: results, reqId: syncReq.id };
        }
        
        // --- DB Operations ---
        if (type === 'db_op') {
           const { cmd, collection, data } = payload;
           const redisKey = \`websim:data:\${collection}\`;
           
           if (cmd === 'create' || cmd === 'update') {
               await context.redis.hSet(redisKey, { [data.id]: JSON.stringify(data) });
           } else if (cmd === 'delete') {
               await context.redis.hDel(redisKey, [data.id]);
           }
           
           return { type: 'broadcast_op', payload, reqId: syncReq.id };
        }

        // --- User Context ---
        if (type === 'get_user') {
            try {
                const user = await context.reddit.getCurrentUser();
                return { 
                    type: 'user_context', 
                    user: {
                        id: user.id,
                        username: user.username,
                        avatar_url: user.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                    }, 
                    reqId: syncReq.id 
                };
            } catch(e) {
                return { 
                    type: 'user_context', 
                    user: { id: 'anon', username: 'Anonymous', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' }, 
                    reqId: syncReq.id 
                };
            }
        }

      } catch (err) {
        console.error('[Server] Error:', err);
        return { type: 'error', error: String(err), reqId: syncReq.id };
      }
      return null;
    }, { depends: [syncReq.id] });

    // 3. REALTIME: Channel
    const channel = useChannel({
      name: 'websim_global',
      onMessage: (msg) => {
        context.ui.webView.postMessage('gameview_' + key, {
          type: 'WEBSIM_SOCKET_EVT',
          payload: msg
        });
      },
    });
    channel.subscribe();

    // 4. CLIENT: Process Server Results
    if (serverRes && serverRes.reqId !== lastProcessed) {
        setLastProcessed(serverRes.reqId);
        
        if (serverRes.type === 'batch_dump') {
            context.ui.webView.postMessage('gameview_' + key, {
                type: 'WEBSIM_SOCKET_EVT',
                payload: { type: 'batch_dump', data: serverRes.data }
            });
        } 
        else if (serverRes.type === 'broadcast_op') {
             channel.send({
                type: 'db_sync',
                collection: serverRes.payload.collection,
                op: serverRes.payload
            });
        }
        else if (serverRes.type === 'user_context') {
             context.ui.webView.postMessage('gameview_' + key, {
                type: 'set_user_context',
                payload: serverRes.user
             });
        }
    }

    // 5. RENDER
    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id={'gameview_' + key}
          url="${webviewPath}"
          width="100%"
          height="100%"
          onMessage={(event) => {
            // Strictly only State Updates here
            let msg = event;
            if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch(e){} }
            if (!msg || typeof msg !== 'object') return;

            if (msg.type === 'webViewReady') {
                setSyncReq({
                    id: Math.random(),
                    type: 'batch_load',
                    payload: { collections: msg.payload?.collections || [] }
                });
            }
            else if (msg.type === 'WEBSIM_SOCKET_MSG') {
                const { type, payload } = msg.payload || {};
                if (type === 'db_op') {
                     setSyncReq({ id: Math.random(), type: 'db_op', payload });
                } else {
                    channel.send(msg.payload);
                }
            }
            else if (msg.type === 'get_user_context') {
                 setSyncReq({ id: Math.random(), type: 'get_user', payload: {} });
            }
            else if (msg.type === 'console') {
                const args = ['[Web]', ...(msg.args || [])];
                if (msg.level === 'error') console.error(...args);
                else console.log(...args);
            }
          }}
        />
        <vstack padding="small">
          <button size="small" appearance="bordered" icon="refresh" onPress={() => setKey(k => k + 1)}>Reload</button>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${safeTitle}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${safeTitle}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;
};

